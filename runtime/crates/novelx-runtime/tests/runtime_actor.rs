use novelx_protocol::{Envelope, MessageType};
use novelx_runtime::runtime_actor::{
    RuntimeActor, RuntimeActorError, RuntimeOutputDraft, RuntimeTaskKey,
};
use std::io;
use std::pin::Pin;
use std::sync::{Arc, Mutex};
use std::task::{Context, Poll};
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::sync::oneshot;
use tokio::time::{Duration, timeout};

#[tokio::test]
async fn pending_long_task_does_not_block_status_or_shutdown_and_one_writer_orders_all_output() {
    let (writer, reader) = tokio::io::duplex(16 * 1024);
    let (actor, handle) = RuntimeActor::new(writer, 2, 8);
    let actor_task = tokio::spawn(actor.run());
    let mut lines = BufReader::new(reader).lines();
    let (release_tx, release_rx) = oneshot::channel();

    handle
        .start_task(
            task_key(),
            draft("task.accepted", MessageType::Response),
            draft("runtime.error", MessageType::Event),
            move |_| {
                Box::pin(async move {
                    release_rx.await.unwrap();
                    Ok(draft("task.completed", MessageType::Event))
                })
            },
        )
        .await
        .unwrap();
    let accepted = next_envelope(&mut lines).await;
    assert_eq!(accepted.name, "task.accepted");
    assert_eq!(accepted.sequence, 3);

    handle
        .emit(draft("runtime.status", MessageType::Response))
        .await
        .unwrap();
    let status = next_envelope(&mut lines).await;
    assert_eq!(status.name, "runtime.status");
    assert_eq!(status.sequence, 4);

    release_tx.send(()).unwrap();
    let completed = next_envelope(&mut lines).await;
    assert_eq!(completed.name, "task.completed");
    assert_eq!(completed.sequence, 5);

    handle
        .shutdown(draft("runtime.stopped", MessageType::Control))
        .await
        .unwrap();
    let stopped = next_envelope(&mut lines).await;
    assert_eq!(stopped.name, "runtime.stopped");
    assert_eq!(stopped.sequence, 6);
    assert!(actor_task.await.unwrap().is_ok());
}

#[tokio::test]
async fn drain_waits_for_pending_task_terminal_before_stopped() {
    let (writer, reader) = tokio::io::duplex(16 * 1024);
    let (actor, handle) = RuntimeActor::new(writer, 20, 4);
    let actor_task = tokio::spawn(actor.run());
    let mut lines = BufReader::new(reader).lines();
    let (release_tx, release_rx) = oneshot::channel();

    handle
        .start_task(
            task_key(),
            draft("task.accepted", MessageType::Response),
            draft("runtime.error", MessageType::Event),
            |_| {
                Box::pin(async move {
                    release_rx.await.unwrap();
                    Ok(draft("task.completed", MessageType::Event))
                })
            },
        )
        .await
        .unwrap();
    assert_eq!(next_envelope(&mut lines).await.sequence, 21);

    let shutdown = tokio::spawn({
        let handle = handle.clone();
        async move {
            handle
                .shutdown(draft("runtime.stopped", MessageType::Control))
                .await
        }
    });
    assert!(
        timeout(Duration::from_millis(50), lines.next_line())
            .await
            .is_err(),
        "runtime.stopped must not overtake a pending task terminal"
    );

    release_tx.send(()).unwrap();
    let completed = next_envelope(&mut lines).await;
    assert_eq!(completed.name, "task.completed");
    assert_eq!(completed.sequence, 22);
    let stopped = next_envelope(&mut lines).await;
    assert_eq!(stopped.name, "runtime.stopped");
    assert_eq!(stopped.sequence, 23);
    shutdown.await.unwrap().unwrap();
    assert!(actor_task.await.unwrap().is_ok());
    assert!(lines.next_line().await.unwrap().is_none());
}

#[tokio::test]
async fn drain_rejects_new_tasks_with_an_explicit_error() {
    let (writer, reader) = tokio::io::duplex(16 * 1024);
    let (actor, handle) = RuntimeActor::new(writer, 25, 4);
    let actor_task = tokio::spawn(actor.run());
    let mut lines = BufReader::new(reader).lines();
    let (release_tx, release_rx) = oneshot::channel();

    handle
        .start_task(
            task_key(),
            draft("task.accepted", MessageType::Response),
            draft("runtime.error", MessageType::Event),
            |_| {
                Box::pin(async move {
                    release_rx.await.unwrap();
                    Ok(draft("task.completed", MessageType::Event))
                })
            },
        )
        .await
        .unwrap();
    assert_eq!(next_envelope(&mut lines).await.name, "task.accepted");

    let drain = handle
        .begin_drain(draft("runtime.stopped", MessageType::Control))
        .await
        .unwrap();
    let rejected = handle
        .start_task(
            task_key(),
            draft("second.accepted", MessageType::Response),
            draft("runtime.error", MessageType::Event),
            |_| Box::pin(async { Ok(draft("second.completed", MessageType::Event)) }),
        )
        .await
        .unwrap_err();
    assert!(matches!(rejected, RuntimeActorError::Draining));

    release_tx.send(()).unwrap();
    assert_eq!(next_envelope(&mut lines).await.name, "task.completed");
    drain.finish_stop().await.unwrap();
    let stopped = next_envelope(&mut lines).await;
    assert_eq!(stopped.name, "runtime.stopped");
    assert_eq!(stopped.sequence, 28);
    assert!(actor_task.await.unwrap().is_ok());
    assert!(lines.next_line().await.unwrap().is_none());
}

#[tokio::test]
async fn stdout_failure_before_task_terminal_never_attempts_runtime_stopped() {
    let state = Arc::new(Mutex::new(RecordingWriterState::default()));
    let writer = FailOnNameWriter {
        state: Arc::clone(&state),
        fail_on: b"task.completed".to_vec(),
    };
    let (actor, handle) = RuntimeActor::new(writer, 28, 4);
    let actor_task = tokio::spawn(actor.run());
    let (release_tx, release_rx) = oneshot::channel();

    handle
        .start_task(
            task_key(),
            draft("task.accepted", MessageType::Response),
            draft("runtime.error", MessageType::Event),
            |_| {
                Box::pin(async move {
                    release_rx.await.unwrap();
                    Ok(draft("task.completed", MessageType::Event))
                })
            },
        )
        .await
        .unwrap();
    let drain = handle
        .begin_drain(draft("runtime.stopped", MessageType::Control))
        .await
        .unwrap();
    release_tx.send(()).unwrap();

    let actor_error = actor_task.await.unwrap().unwrap_err();
    assert!(matches!(actor_error, RuntimeActorError::Io(_)));
    assert!(matches!(
        drain.finish_stop().await.unwrap_err(),
        RuntimeActorError::Closed
    ));
    let output = String::from_utf8(state.lock().unwrap().bytes.clone()).unwrap();
    assert!(output.contains("task.accepted"));
    assert!(!output.contains("runtime.stopped"));
}

#[tokio::test]
async fn drain_without_tasks_stops_immediately() {
    let (writer, reader) = tokio::io::duplex(16 * 1024);
    let (actor, handle) = RuntimeActor::new(writer, 33, 4);
    let actor_task = tokio::spawn(actor.run());
    let mut lines = BufReader::new(reader).lines();

    handle
        .shutdown(draft("runtime.stopped", MessageType::Control))
        .await
        .unwrap();
    let stopped = next_envelope(&mut lines).await;
    assert_eq!(stopped.name, "runtime.stopped");
    assert_eq!(stopped.sequence, 34);
    assert!(actor_task.await.unwrap().is_ok());
}

#[tokio::test]
async fn queued_emit_after_drain_and_before_finish_precedes_runtime_stopped() {
    let (writer, reader) = tokio::io::duplex(16 * 1024);
    let (actor, handle) = RuntimeActor::new(writer, 34, 4);
    let actor_task = tokio::spawn(actor.run());
    let mut lines = BufReader::new(reader).lines();

    let drain = handle
        .begin_drain(draft("runtime.stopped", MessageType::Control))
        .await
        .unwrap();
    handle
        .emit(draft("runtime.status", MessageType::Response))
        .await
        .unwrap();
    drain.finish_stop().await.unwrap();

    let status = next_envelope(&mut lines).await;
    assert_eq!(status.name, "runtime.status");
    assert_eq!(status.sequence, 35);
    let stopped = next_envelope(&mut lines).await;
    assert_eq!(stopped.name, "runtime.stopped");
    assert_eq!(stopped.sequence, 36);
    assert!(actor_task.await.unwrap().is_ok());
}

#[tokio::test]
async fn mailbox_close_without_begin_drain_emits_no_runtime_stopped() {
    let (writer, reader) = tokio::io::duplex(16 * 1024);
    let (actor, handle) = RuntimeActor::new(writer, 36, 4);
    let actor_task = tokio::spawn(actor.run());
    let mut lines = BufReader::new(reader).lines();

    drop(handle);
    assert!(actor_task.await.unwrap().is_ok());
    assert!(lines.next_line().await.unwrap().is_none());
}

#[tokio::test]
async fn task_mapping_failure_emits_the_declared_runtime_error_without_panicking() {
    let (writer, reader) = tokio::io::duplex(16 * 1024);
    let (actor, handle) = RuntimeActor::new(writer, 30, 4);
    let actor_task = tokio::spawn(actor.run());
    let mut lines = BufReader::new(reader).lines();
    handle
        .start_task(
            task_key(),
            draft("task.accepted", MessageType::Response),
            draft("runtime.error", MessageType::Event),
            |_| Box::pin(async { Err("terminal mapping failed".to_owned()) }),
        )
        .await
        .unwrap();
    assert_eq!(next_envelope(&mut lines).await.name, "task.accepted");
    let failure = next_envelope(&mut lines).await;
    assert_eq!(failure.name, "runtime.error");
    assert_eq!(failure.sequence, 32);
    handle
        .shutdown(draft("runtime.stopped", MessageType::Control))
        .await
        .unwrap();
    assert!(actor_task.await.unwrap().is_ok());
}

#[tokio::test]
async fn cancel_run_signals_the_matching_run_attempt() {
    let (writer, reader) = tokio::io::duplex(16 * 1024);
    let (actor, handle) = RuntimeActor::new(writer, 40, 4);
    let actor_task = tokio::spawn(actor.run());
    let mut lines = BufReader::new(reader).lines();
    let key = task_key();
    handle
        .start_task(
            key,
            draft("task.accepted", MessageType::Response),
            draft("runtime.error", MessageType::Event),
            |mut cancellation| {
                Box::pin(async move {
                    cancellation
                        .changed()
                        .await
                        .map_err(|error| error.to_string())?;
                    if *cancellation.borrow() {
                        Ok(draft("task.cancelled", MessageType::Event))
                    } else {
                        Err("cancellation signal was false".to_owned())
                    }
                })
            },
        )
        .await
        .unwrap();
    assert_eq!(next_envelope(&mut lines).await.name, "task.accepted");
    handle.cancel_run(key.run_id).await.unwrap();
    assert_eq!(next_envelope(&mut lines).await.name, "task.cancelled");
    handle
        .shutdown(draft("runtime.stopped", MessageType::Control))
        .await
        .unwrap();
    assert!(actor_task.await.unwrap().is_ok());
}

#[tokio::test]
async fn streaming_task_progress_is_acknowledged_and_ordered_before_terminal_output() {
    let (writer, reader) = tokio::io::duplex(16 * 1024);
    let (actor, handle) = RuntimeActor::new(writer, 50, 8);
    let actor_task = tokio::spawn(actor.run());
    let mut lines = BufReader::new(reader).lines();

    handle
        .start_streaming_task(
            task_key(),
            draft("task.accepted", MessageType::Response),
            draft("runtime.error", MessageType::Event),
            |_, progress| {
                Box::pin(async move {
                    progress
                        .emit(draft("tool.requested", MessageType::Event))
                        .await
                        .map_err(|error| error.to_string())?;
                    progress
                        .emit(draft("tool.running", MessageType::Event))
                        .await
                        .map_err(|error| error.to_string())?;
                    Ok(draft("task.completed", MessageType::Event))
                })
            },
        )
        .await
        .unwrap();

    assert_eq!(next_envelope(&mut lines).await.name, "task.accepted");
    assert_eq!(next_envelope(&mut lines).await.name, "tool.requested");
    assert_eq!(next_envelope(&mut lines).await.name, "tool.running");
    assert_eq!(next_envelope(&mut lines).await.name, "task.completed");
    handle
        .shutdown(draft("runtime.stopped", MessageType::Control))
        .await
        .unwrap();
    assert!(actor_task.await.unwrap().is_ok());
}

fn task_key() -> RuntimeTaskKey {
    RuntimeTaskKey {
        run_id: uuid::Uuid::new_v4(),
        attempt_id: uuid::Uuid::new_v4(),
    }
}

fn draft(name: &str, message_type: MessageType) -> RuntimeOutputDraft {
    RuntimeOutputDraft {
        message_type,
        name: name.to_owned(),
        sent_at: "2026-07-12T00:00:00Z".to_owned(),
        correlation_id: None,
        run_id: None,
        payload: serde_json::json!({}),
    }
}

async fn next_envelope(
    lines: &mut tokio::io::Lines<BufReader<tokio::io::DuplexStream>>,
) -> Envelope {
    serde_json::from_str(&lines.next_line().await.unwrap().unwrap()).unwrap()
}

#[derive(Default)]
struct RecordingWriterState {
    bytes: Vec<u8>,
    failed: bool,
}

struct FailOnNameWriter {
    state: Arc<Mutex<RecordingWriterState>>,
    fail_on: Vec<u8>,
}

impl tokio::io::AsyncWrite for FailOnNameWriter {
    fn poll_write(
        self: Pin<&mut Self>,
        _context: &mut Context<'_>,
        buffer: &[u8],
    ) -> Poll<Result<usize, io::Error>> {
        let mut state = self.state.lock().unwrap();
        if !state.failed
            && buffer
                .windows(self.fail_on.len())
                .any(|window| window == self.fail_on)
        {
            state.failed = true;
            return Poll::Ready(Err(io::Error::new(
                io::ErrorKind::BrokenPipe,
                "injected stdout failure",
            )));
        }
        state.bytes.extend_from_slice(buffer);
        Poll::Ready(Ok(buffer.len()))
    }

    fn poll_flush(self: Pin<&mut Self>, _context: &mut Context<'_>) -> Poll<Result<(), io::Error>> {
        Poll::Ready(Ok(()))
    }

    fn poll_shutdown(
        self: Pin<&mut Self>,
        _context: &mut Context<'_>,
    ) -> Poll<Result<(), io::Error>> {
        Poll::Ready(Ok(()))
    }
}
