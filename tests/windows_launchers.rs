#![cfg(windows)]

use std::{
    fs,
    io::Write,
    path::Path,
    process::{Command, Stdio},
};

#[test]
fn actual_batch_launchers_handle_success_failure_pause_and_build() {
    let project = Path::new(env!("CARGO_MANIFEST_DIR"));
    let temp = tempfile::tempdir().unwrap();
    let root = temp.path().join("Project");
    fs::create_dir_all(root.join("scripts")).unwrap();
    fs::create_dir_all(root.join("target/release")).unwrap();
    let wrappers = [
        "双击运行同步Wiki.bat",
        "双击运行同步API.bat",
        "双击运行同步Wiki+API.bat",
    ];
    for file in wrappers.iter().copied().chain(["scripts/sync-rust.bat"]) {
        let bytes = fs::read(project.join(file)).unwrap();
        assert!(
            !bytes.starts_with(&[0xef, 0xbb, 0xbf]),
            "{file}: unexpected BOM"
        );
        for (index, byte) in bytes.iter().enumerate() {
            if *byte == b'\n' {
                assert!(
                    index > 0 && bytes[index - 1] == b'\r',
                    "{file}: bare LF at {index}"
                );
            }
        }
        fs::write(root.join(file), bytes).unwrap();
    }

    // 编译小型测试程序代替网络同步，实际 cmd.exe 执行未经修改的 BAT。
    let source = temp.path().join("stub.rs");
    fs::write(&source, r#"fn main() {
        let args: Vec<_> = std::env::args().skip(1).collect();
        let code: i32 = std::env::var("OASIS_TEST_EXIT").unwrap_or_default().parse().unwrap_or(0);
        if args.first().is_some_and(|arg| arg == "build") && code == 0 {
            std::fs::copy(std::env::current_exe().unwrap(), "target/release/oasis-skill-plus.exe").unwrap();
        }
        println!("stub: {}", args.join(" "));
        std::process::exit(code);
    }"#).unwrap();
    let stub = temp.path().join("stub.exe");
    let rustc = std::env::var_os("RUSTC")
        .map(std::path::PathBuf::from)
        .unwrap_or_else(|| {
            Path::new(&std::env::var_os("USERPROFILE").unwrap()).join(".cargo/bin/rustc.exe")
        });
    let output = Command::new(rustc)
        .arg(&source)
        .arg("-o")
        .arg(&stub)
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    let binary = root.join("target/release/oasis-skill-plus.exe");
    fs::copy(&stub, &binary).unwrap();

    for (wrapper, mode) in wrappers.iter().zip(["sync", "sync-api", "sync-all"]) {
        for code in [0, 7] {
            for pause in [false, true] {
                // 从其他目录调用；外部批处理同时校验返回码与原始代码页恢复。
                let harness = temp.path().join("run.bat");
                fs::write(&harness, format!("@echo off\r\nchcp 65001 >nul\r\ncall \"{}\" {}\r\nset RESULT=%ERRORLEVEL%\r\nchcp\r\nexit /b %RESULT%\r\n", root.join(wrapper).display(), if pause { "" } else { "--no-pause" })).unwrap();
                let mut child = Command::new("cmd.exe")
                    .args(["/d", "/c"])
                    .arg(&harness)
                    .current_dir(temp.path())
                    .env("OASIS_TEST_EXIT", code.to_string())
                    .stdin(Stdio::piped())
                    .stdout(Stdio::piped())
                    .stderr(Stdio::piped())
                    .spawn()
                    .unwrap();
                child.stdin.take().unwrap().write_all(b"\r\n").unwrap();
                let output = child.wait_with_output().unwrap();
                let stdout = String::from_utf8_lossy(&output.stdout);
                assert_eq!(output.status.code(), Some(code), "{wrapper}: {stdout}");
                assert!(
                    output.stderr.is_empty(),
                    "{wrapper}: {}",
                    String::from_utf8_lossy(&output.stderr)
                );
                assert!(stdout.contains(&format!("stub: {mode}")), "{stdout}");
                assert_eq!(
                    stdout.contains("[完成] 同步已完成。"),
                    code == 0,
                    "{stdout}"
                );
                assert_eq!(
                    stdout.contains("[失败] 同步失败，退出码：7。"),
                    code == 7,
                    "{stdout}"
                );
                assert_eq!(stdout.contains("请按任意键继续..."), pause, "{stdout}");
                assert!(stdout.contains("65001"), "code page not restored: {stdout}");
            }
        }
    }

    // 首次构建以及 Cargo 不在 PATH 时的用户目录查找。
    let profile = temp.path().join("profile");
    fs::create_dir_all(profile.join(".cargo/bin")).unwrap();
    fs::copy(&stub, profile.join(".cargo/bin/cargo.exe")).unwrap();
    for code in [7, 0] {
        if binary.exists() {
            fs::remove_file(&binary).unwrap();
        }
        let output = Command::new("cmd.exe")
            .args(["/d", "/c", "call"])
            .arg(root.join(wrappers[2]))
            .arg("--no-pause")
            .env("USERPROFILE", &profile)
            .env(
                "PATH",
                Path::new(&std::env::var_os("SystemRoot").unwrap()).join("System32"),
            )
            .env("OASIS_TEST_EXIT", code.to_string())
            .output()
            .unwrap();
        let stdout = String::from_utf8_lossy(&output.stdout);
        assert_eq!(output.status.code(), Some(code), "{stdout}");
        assert!(
            output.stderr.is_empty(),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
        assert!(stdout.contains("stub: build --release"), "{stdout}");
        assert_eq!(
            stdout.contains("[完成] 同步已完成。"),
            code == 0,
            "{stdout}"
        );
    }
}
