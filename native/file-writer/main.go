package main

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"
	"sync"
)

type item struct {
	Filename  string `json:"filename"`
	Content   string `json:"content"`
	CheckOnly bool   `json:"checkOnly"`
}

type request struct {
	Directory   string `json:"directory"`
	Concurrency int    `json:"concurrency"`
	Items       []item `json:"items"`
}

// 先验证整个批次，拒绝越界路径和 Windows 下同名目标，避免并发覆盖。
func validate(input request) error {
	if input.Concurrency < 1 || input.Concurrency > 128 {
		return errors.New("并发数必须在 1 到 128 之间")
	}
	info, err := os.Stat(input.Directory)
	if err != nil || !info.IsDir() {
		return errors.New("输出目录不存在")
	}
	seen := make(map[string]bool)
	for _, job := range input.Items {
		name := filepath.FromSlash(job.Filename)
		key := strings.ToLower(filepath.Clean(name))
		if !filepath.IsLocal(name) || key == "." || strings.ContainsAny(job.Filename, `\:`) || seen[key] {
			return fmt.Errorf("无效或重复的文件名：%q", job.Filename)
		}
		seen[key] = true
	}
	return nil
}

// 内容相同时保持文件时间；仅为新增或变化的内容创建目录并写入。
func writeFile(directory string, job item, mkdir func() error) error {
	target := filepath.Join(directory, filepath.FromSlash(job.Filename))
	// manifest 未变化时只检查是否存在，与原 JS 行为一致，缺失文件仍需补回。
	if job.CheckOnly {
		if _, err := os.Stat(target); err == nil {
			return nil
		} else if !os.IsNotExist(err) {
			return err
		}
	}
	content := []byte(job.Content)
	current, err := os.ReadFile(target)
	if err == nil && bytes.Equal(current, content) {
		return nil
	}
	if err != nil && !os.IsNotExist(err) {
		return err
	}
	if err = mkdir(); err != nil {
		return err
	}
	return os.WriteFile(target, content, 0644)
}

func run(input request, output io.Writer) error {
	if err := validate(input); err != nil {
		return err
	}
	jobs := make(chan int)
	cancelled := make(chan struct{})
	var workers sync.WaitGroup
	var once sync.Once
	var outputMu sync.Mutex
	var failure error
	encoder := json.NewEncoder(output)
	// 同一个父目录只创建一次，避免几千个文件反复查询同一目录。
	directories := make(map[string]func() error)
	for _, job := range input.Items {
		dir := filepath.Dir(filepath.FromSlash(job.Filename))
		if _, ok := directories[dir]; !ok {
			parent := filepath.Join(input.Directory, dir)
			directories[dir] = sync.OnceValue(func() error { return os.MkdirAll(parent, 0755) })
		}
	}
	// 失败后停止分发，等待已经开始的写入关闭文件，再把错误返回 JS。
	fail := func(err error) { once.Do(func() { failure = err; close(cancelled) }) }
	for worker := 0; worker < input.Concurrency; worker++ {
		workers.Add(1)
		go func() {
			defer workers.Done()
			for index := range jobs {
				select {
				case <-cancelled:
					return
				default:
				}
				job := input.Items[index]
				if err := writeFile(input.Directory, job, directories[filepath.Dir(filepath.FromSlash(job.Filename))]); err != nil {
					fail(err)
					return
				}
				outputMu.Lock()
				err := encoder.Encode(struct {
					Index int `json:"index"`
				}{index})
				outputMu.Unlock()
				if err != nil {
					fail(err)
					return
				}
			}
		}()
	}
sendJobs:
	for index := range input.Items {
		select {
		case <-cancelled:
			break sendJobs
		case jobs <- index:
		}
	}
	close(jobs)
	workers.Wait()
	return failure
}

func main() {
	// 一次进程处理整批文档，减少 JS 与操作系统之间的逐文件往返。
	var input request
	err := json.NewDecoder(io.LimitReader(os.Stdin, 32<<20)).Decode(&input)
	if err == nil {
		err = run(input, os.Stdout)
	}
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}
