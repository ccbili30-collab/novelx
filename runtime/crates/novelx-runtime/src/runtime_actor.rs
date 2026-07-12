use std::future::Future;
use std::pin::Pin;

use novelx_protocol::{Envelope, MAX_SAFE_SEQUENCE, MessageType, PROTOCOL_VERSION};
use serde_json::Value;
use thiserror::Error;
use tokio::io::{AsyncWrite, AsyncWriteExt};
use tokio::sync::mpsc;
use tokio::task::JoinSet;
use uuid::Uuid;

pub type RuntimeTask = Pin<Box<dyn Future<Output = RuntimeOutputDraft> + Send + 'static>>;

#[derive(Clone, Debug, PartialEq)]
pub struct RuntimeOutputDraft {
    pub message_type: MessageType,
    pub name: String,
    pub sent_at: String,
    pub correlation_id: Option<Uuid>,
    pub run_id: Option<Uuid>,
    pub payload: Value,
}

pub struct RuntimeActor<W> {
    writer: W,
    next_sequence: u64,
    commands: mpsc::Receiver<RuntimeActorCommand>,
    tasks: JoinSet<RuntimeOutputDraft>,
}

#[derive(Clone)]
pub struct RuntimeActorHandle {
    commands: mpsc::Sender<RuntimeActorCommand>,
}

enum RuntimeActorCommand {
    Emit(RuntimeOutputDraft),
    StartTask {
        accepted: RuntimeOutputDraft,
        task: RuntimeTask,
    },
    Shutdown(RuntimeOutputDraft),
}

impl<W> RuntimeActor<W>
where
    W: AsyncWrite + Unpin,
{
    pub fn new(
        writer: W,
        last_sequence: u64,
        mailbox_capacity: usize,
    ) -> (Self, RuntimeActorHandle) {
        let (sender, commands) = mpsc::channel(mailbox_capacity.max(1));
        (
            Self {
                writer,
                next_sequence: last_sequence.checked_add(1).unwrap_or(0),
                commands,
                tasks: JoinSet::new(),
            },
            RuntimeActorHandle { commands: sender },
        )
    }

    pub async fn run(mut self) -> Result<(), RuntimeActorError> {
        loop {
            tokio::select! {
                biased;
                command = self.commands.recv() => {
                    match command {
                        Some(RuntimeActorCommand::Emit(output)) => self.write(output).await?,
                        Some(RuntimeActorCommand::StartTask { accepted, task }) => {
                            self.write(accepted).await?;
                            self.tasks.spawn(task);
                        }
                        Some(RuntimeActorCommand::Shutdown(output)) => {
                            self.write(output).await?;
                            self.tasks.abort_all();
                            return Ok(());
                        }
                        None => {
                            self.tasks.abort_all();
                            return Ok(());
                        }
                    }
                }
                completed = self.tasks.join_next(), if !self.tasks.is_empty() => {
                    let output = completed
                        .ok_or(RuntimeActorError::TaskSetEmpty)?
                        .map_err(RuntimeActorError::TaskJoin)?;
                    self.write(output).await?;
                }
            }
        }
    }

    async fn write(&mut self, output: RuntimeOutputDraft) -> Result<(), RuntimeActorError> {
        if self.next_sequence == 0 || self.next_sequence > MAX_SAFE_SEQUENCE {
            return Err(RuntimeActorError::SequenceExhausted);
        }
        let envelope = Envelope {
            protocol_version: PROTOCOL_VERSION,
            message_id: Uuid::new_v4(),
            message_type: output.message_type,
            name: output.name,
            sent_at: output.sent_at,
            correlation_id: output.correlation_id,
            run_id: output.run_id,
            sequence: self.next_sequence,
            payload: output.payload,
        };
        let bytes = serde_json::to_vec(&envelope)?;
        self.writer.write_all(&bytes).await?;
        self.writer.write_all(b"\n").await?;
        self.writer.flush().await?;
        self.next_sequence = self
            .next_sequence
            .checked_add(1)
            .ok_or(RuntimeActorError::SequenceExhausted)?;
        Ok(())
    }
}

impl RuntimeActorHandle {
    pub async fn emit(&self, output: RuntimeOutputDraft) -> Result<(), RuntimeActorError> {
        self.commands
            .send(RuntimeActorCommand::Emit(output))
            .await
            .map_err(|_| RuntimeActorError::Closed)
    }

    pub async fn start_task(
        &self,
        accepted: RuntimeOutputDraft,
        task: RuntimeTask,
    ) -> Result<(), RuntimeActorError> {
        self.commands
            .send(RuntimeActorCommand::StartTask { accepted, task })
            .await
            .map_err(|_| RuntimeActorError::Closed)
    }

    pub async fn shutdown(&self, output: RuntimeOutputDraft) -> Result<(), RuntimeActorError> {
        self.commands
            .send(RuntimeActorCommand::Shutdown(output))
            .await
            .map_err(|_| RuntimeActorError::Closed)
    }
}

#[derive(Debug, Error)]
pub enum RuntimeActorError {
    #[error("Runtime Actor mailbox is closed")]
    Closed,
    #[error("Runtime Actor output sequence is exhausted")]
    SequenceExhausted,
    #[error("Runtime Actor task set returned no task")]
    TaskSetEmpty,
    #[error("Runtime Actor task failed: {0}")]
    TaskJoin(tokio::task::JoinError),
    #[error(transparent)]
    Io(#[from] std::io::Error),
    #[error(transparent)]
    Serialize(#[from] serde_json::Error),
}
