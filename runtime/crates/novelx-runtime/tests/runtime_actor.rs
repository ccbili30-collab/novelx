use novelx_protocol::{Envelope, MessageType};
use novelx_runtime::runtime_actor::{RuntimeActor, RuntimeOutputDraft};
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::sync::oneshot;

#[tokio::test]
async fn pending_long_task_does_not_block_status_or_shutdown_and_one_writer_orders_all_output() {
    let (writer, reader) = tokio::io::duplex(16 * 1024);
    let (actor, handle) = RuntimeActor::new(writer, 2, 8);
    let actor_task = tokio::spawn(actor.run());
    let mut lines = BufReader::new(reader).lines();
    let (release_tx, release_rx) = oneshot::channel();

    handle
        .start_task(
            draft("task.accepted", MessageType::Response),
            Box::pin(async move {
                release_rx.await.unwrap();
                draft("task.completed", MessageType::Event)
            }),
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
async fn shutdown_aborts_a_still_pending_task_and_emits_no_fake_terminal_output() {
    let (writer, reader) = tokio::io::duplex(16 * 1024);
    let (actor, handle) = RuntimeActor::new(writer, 20, 4);
    let actor_task = tokio::spawn(actor.run());
    let mut lines = BufReader::new(reader).lines();

    handle
        .start_task(
            draft("task.accepted", MessageType::Response),
            Box::pin(std::future::pending()),
        )
        .await
        .unwrap();
    assert_eq!(next_envelope(&mut lines).await.sequence, 21);

    handle
        .shutdown(draft("runtime.stopped", MessageType::Control))
        .await
        .unwrap();
    let stopped = next_envelope(&mut lines).await;
    assert_eq!(stopped.name, "runtime.stopped");
    assert_eq!(stopped.sequence, 22);
    assert!(actor_task.await.unwrap().is_ok());
    assert!(lines.next_line().await.unwrap().is_none());
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
