use crossterm::{
    cursor::{MoveToColumn, MoveUp},
    queue,
    terminal::{self, Clear, ClearType},
};
use oasis_skill_plus::{api_sync::ApiProgress, sync::ProgressEvent};
use std::{
    io::{self, IsTerminal, Write},
    sync::{Arc, Mutex},
    time::{Duration, Instant},
};

const PHASES: [&[&str]; 2] = [
    &["category", "articles", "images", "finalize"],
    &["catalogs", "details", "finalize"],
];

// 两项同步共享显示状态与输出锁；下载任务仍保持各自的并发度。
pub struct Reporter {
    combined: bool,
    terminal: bool,
    events: [Vec<Option<ProgressEvent>>; 2],
    drawn_rows: u16,
    active_line_width: usize,
    last_render: Option<Instant>,
}

impl Reporter {
    pub fn new(combined: bool) -> Arc<Mutex<Self>> {
        Arc::new(Mutex::new(Self {
            combined,
            terminal: io::stdout().is_terminal(),
            events: [vec![None; 4], vec![None; 3]],
            drawn_rows: 0,
            active_line_width: 0,
            last_render: None,
        }))
    }

    pub fn wiki_callback(reporter: &Arc<Mutex<Self>>) -> Arc<dyn Fn(ProgressEvent) + Send + Sync> {
        let reporter = Arc::clone(reporter);
        Arc::new(move |event| reporter.lock().unwrap().update(0, event))
    }

    pub fn api_callback(reporter: &Arc<Mutex<Self>>) -> Arc<dyn Fn(ApiProgress) + Send + Sync> {
        let reporter = Arc::clone(reporter);
        Arc::new(move |event| {
            reporter.lock().unwrap().update(
                1,
                ProgressEvent {
                    phase: event.phase,
                    label: event.label,
                    current: event.current,
                    total: event.total,
                    done: event.done,
                },
            )
        })
    }

    fn update(&mut self, task: usize, event: ProgressEvent) {
        let stage = PHASES[task]
            .iter()
            .position(|phase| *phase == event.phase)
            .unwrap_or(0);
        let new_stage = self.events[task][stage].is_none();
        let done = event.done;
        self.events[task][stage] = Some(event);
        if self.combined {
            // 与旧版一致：终端最多每 50ms 重绘，重定向时仅在结束后输出完整表格。
            if self.terminal
                && (new_stage
                    || done
                    || self
                        .last_render
                        .is_none_or(|time| time.elapsed() >= Duration::from_millis(50)))
            {
                let _ = self.render_combined();
            }
        } else {
            let event = self.events[task][stage].as_ref().unwrap();
            let line = format_progress_line(
                stage + 1,
                PHASES[task].len(),
                &event.label,
                event.current,
                event.total,
            );
            let mut output = io::stdout().lock();
            if self.terminal {
                let width = display_width(&line);
                let _ = write!(
                    output,
                    "\r{line}{}",
                    " ".repeat(self.active_line_width.saturating_sub(width))
                );
                self.active_line_width = self.active_line_width.max(width);
                if done {
                    let _ = writeln!(output);
                    self.active_line_width = 0;
                }
                let _ = output.flush();
            } else {
                let _ = writeln!(output, "{line}");
            }
        }
    }

    fn combined_rows(&self, width: usize) -> Vec<String> {
        let cell_width = width.saturating_sub(4).checked_div(2).unwrap_or(0).max(1);
        let columns: Vec<Vec<String>> = ["Wiki", "API"]
            .iter()
            .enumerate()
            .map(|(task, title)| {
                let mut rows = vec![title.to_string(), "-".repeat(cell_width)];
                for (stage, event) in self.events[task].iter().enumerate() {
                    let Some(event) = event else {
                        continue;
                    };
                    rows.push(format!(
                        "[{}/{}] {}",
                        stage + 1,
                        PHASES[task].len(),
                        event.label
                    ));
                    let ratio = ratio(event.current, event.total);
                    let filled = (ratio * 10.0).round() as usize;
                    let bar = if cell_width >= 32 {
                        format!("[{}{}] ", "#".repeat(filled), "-".repeat(10 - filled))
                    } else {
                        String::new()
                    };
                    rows.push(format!(
                        "{bar}{}/{} ({}%)",
                        event.current,
                        event.total,
                        (ratio * 100.0).round() as usize
                    ));
                }
                rows
            })
            .collect();
        (0..columns[0].len().max(columns[1].len()))
            .map(|row| {
                format!(
                    "{} | {}",
                    cell(
                        columns[0].get(row).map(String::as_str).unwrap_or(""),
                        cell_width
                    ),
                    cell(
                        columns[1].get(row).map(String::as_str).unwrap_or(""),
                        cell_width
                    )
                )
            })
            .collect()
    }

    fn render_combined(&mut self) -> io::Result<()> {
        let width = if self.terminal {
            terminal::size()
                .map(|size| usize::from(size.0))
                .unwrap_or(80)
        } else {
            80
        };
        let rows = self.combined_rows(width);
        let mut output = io::stdout().lock();
        if self.terminal && self.drawn_rows > 0 {
            queue!(output, MoveUp(self.drawn_rows))?;
        }
        for row in &rows {
            if self.terminal {
                queue!(output, MoveToColumn(0), Clear(ClearType::CurrentLine))?;
            }
            writeln!(output, "{row}")?;
        }
        output.flush()?;
        self.drawn_rows = rows.len() as u16;
        self.last_render = Some(Instant::now());
        Ok(())
    }

    pub fn end(&mut self) {
        if self.combined {
            let _ = self.render_combined();
        } else if self.terminal && self.active_line_width > 0 {
            println!();
            self.active_line_width = 0;
        }
    }
}

fn display_width(text: &str) -> usize {
    text.chars()
        .map(|character| usize::from(character > '\u{00ff}') + 1)
        .sum()
}

fn cell(text: &str, width: usize) -> String {
    let mut visible = String::new();
    let mut used = 0;
    for character in text.chars() {
        let size = usize::from(character > '\u{00ff}') + 1;
        if used + size > width {
            break;
        }
        visible.push(character);
        used += size;
    }
    visible.push_str(&" ".repeat(width - used));
    visible
}

fn ratio(current: usize, total: usize) -> f64 {
    if total == 0 {
        1.0
    } else {
        (current as f64 / total as f64).clamp(0.0, 1.0)
    }
}

pub fn format_progress_line(
    stage: usize,
    count: usize,
    label: &str,
    current: usize,
    total: usize,
) -> String {
    let ratio = ratio(current, total);
    let percentage = (ratio * 100.0).round() as usize;
    let filled = (ratio * 20.0).round() as usize;
    format!(
        "[{stage}/{count}] {label}{} [{}{}] {current:>4}/{total:>4} ({percentage:>3}%)",
        " ".repeat(26usize.saturating_sub(display_width(label))),
        "#".repeat(filled),
        "-".repeat(20 - filled)
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn combined_keeps_completed_stages_and_aligns_chinese_columns() {
        let shared = Reporter::new(true);
        let mut reporter = shared.lock().unwrap();
        reporter.terminal = false;
        for (task, phase, label, count) in [
            (0, "category", "正在加载分类树", 1),
            (0, "articles", "正在抓取词条", 12),
            (1, "catalogs", "正在加载 API 目录", 4),
        ] {
            reporter.update(
                task,
                ProgressEvent {
                    phase: phase.into(),
                    label: label.into(),
                    current: count,
                    total: count,
                    done: true,
                },
            );
        }
        for width in [40, 80, 120] {
            let rows = reporter.combined_rows(width);
            assert_eq!(rows.len(), 6);
            assert!(rows[2].contains("[1/4]"));
            assert!(rows[4].contains("[2/4]"));
            for row in rows {
                let (left, _) = row.split_once(" | ").unwrap();
                assert_eq!(display_width(left), (width - 4) / 2);
                assert_eq!(display_width(&row), width - 1);
                assert!(!row.contains('\x1b'));
            }
        }
    }
}
