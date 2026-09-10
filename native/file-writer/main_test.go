package main

import (
	"bytes"
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
)

func TestWriteAndPreserve(t *testing.T) {
	// 新增、变化、缓存命中及缺失修复都必须保持 JS 原有行为。
	input := request{Directory: t.TempDir(), Concurrency: 8, Items: []item{{Filename: "目录/a.md", Content: "原内容"}, {Filename: "目录/b.md", Content: "内容B"}}}
	var output bytes.Buffer
	if err := run(input, &output); err != nil {
		t.Fatal(err)
	}
	decoder := json.NewDecoder(&output)
	seen := make(map[int]bool)
	for range input.Items {
		var event struct {
			Index int `json:"index"`
		}
		if err := decoder.Decode(&event); err != nil {
			t.Fatal(err)
		}
		if seen[event.Index] {
			t.Fatal("重复完成事件")
		}
		seen[event.Index] = true
	}
	file := filepath.Join(input.Directory, "目录/a.md")
	before, _ := os.Stat(file)
	if err := run(input, &output); err != nil {
		t.Fatal(err)
	}
	after, _ := os.Stat(file)
	if !before.ModTime().Equal(after.ModTime()) {
		t.Fatal("未变化文件被改写")
	}
	input.Items[0].Content = "新内容"
	input.Items[0].CheckOnly = true
	if err := run(input, &output); err != nil {
		t.Fatal(err)
	}
	content, _ := os.ReadFile(file)
	if string(content) != "原内容" {
		t.Fatal("缓存命中被改写")
	}
	if err := os.Remove(file); err != nil {
		t.Fatal(err)
	}
	if err := run(input, &output); err != nil {
		t.Fatal(err)
	}
	content, _ = os.ReadFile(file)
	if string(content) != "新内容" {
		t.Fatal("缺失文件未恢复")
	}
}

func TestValidationAndFailure(t *testing.T) {
	// 整批路径先校验，无效的后续路径也不能导致先写入部分文件。
	directory := t.TempDir()
	for _, bad := range []string{"../escape", `..\escape`, "C:escape", "."} {
		input := request{Directory: directory, Concurrency: 2, Items: []item{{Filename: "ok.md"}, {Filename: bad}}}
		if err := run(input, &bytes.Buffer{}); err == nil {
			t.Fatalf("未拒绝路径：%s", bad)
		}
		if _, err := os.Stat(filepath.Join(directory, "ok.md")); !os.IsNotExist(err) {
			t.Fatal("校验前写入了文件")
		}
	}
	input := request{Directory: directory, Concurrency: 2, Items: []item{{Filename: "A.md"}, {Filename: "a.md"}}}
	if err := run(input, &bytes.Buffer{}); err == nil {
		t.Fatal("重复文件未拒绝")
	}
	if err := os.WriteFile(filepath.Join(directory, "file"), nil, 0644); err != nil {
		t.Fatal(err)
	}
	input.Items = []item{{Filename: "file/child.md"}}
	if err := run(input, &bytes.Buffer{}); err == nil {
		t.Fatal("写入失败未返回错误")
	}
}
