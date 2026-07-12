use std::error::Error;
use std::fmt::{self, Display, Formatter};

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum RunState {
    Created,
    Preparing,
    Running,
    WaitingForApproval,
    WaitingForReconciliation,
    Committing,
    Retrying,
    Blocked,
    Cancelled,
    Failed,
    Completed,
}

impl RunState {
    pub const fn is_terminal(self) -> bool {
        matches!(
            self,
            Self::Blocked | Self::Cancelled | Self::Failed | Self::Completed
        )
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct RunStateMachine {
    state: RunState,
}

impl Default for RunStateMachine {
    fn default() -> Self {
        Self::new()
    }
}

impl RunStateMachine {
    pub const fn new() -> Self {
        Self {
            state: RunState::Created,
        }
    }

    pub const fn state(&self) -> RunState {
        self.state
    }

    pub fn prepare(&mut self) -> Result<(), TransitionError> {
        self.transition(
            RunState::Preparing,
            &[RunState::Created, RunState::Retrying],
        )
    }

    pub fn start(&mut self) -> Result<(), TransitionError> {
        self.transition(
            RunState::Running,
            &[RunState::Preparing, RunState::Retrying],
        )
    }

    pub fn wait_for_approval(&mut self) -> Result<(), TransitionError> {
        self.transition(RunState::WaitingForApproval, &[RunState::Running])
    }

    pub fn wait_for_reconciliation(&mut self) -> Result<(), TransitionError> {
        self.transition(
            RunState::WaitingForReconciliation,
            &[RunState::Running, RunState::Retrying],
        )
    }

    pub fn begin_commit(&mut self) -> Result<(), TransitionError> {
        self.transition(
            RunState::Committing,
            &[RunState::Running, RunState::WaitingForApproval],
        )
    }

    pub fn retry(&mut self) -> Result<(), TransitionError> {
        self.transition(
            RunState::Retrying,
            &[
                RunState::Preparing,
                RunState::Running,
                RunState::WaitingForReconciliation,
                RunState::Committing,
            ],
        )
    }

    pub fn block(&mut self) -> Result<(), TransitionError> {
        self.transition(
            RunState::Blocked,
            &[
                RunState::Preparing,
                RunState::Running,
                RunState::WaitingForApproval,
                RunState::WaitingForReconciliation,
                RunState::Committing,
                RunState::Retrying,
            ],
        )
    }

    pub fn cancel(&mut self) -> Result<(), TransitionError> {
        self.transition(
            RunState::Cancelled,
            &[
                RunState::Created,
                RunState::Preparing,
                RunState::Running,
                RunState::WaitingForApproval,
                RunState::WaitingForReconciliation,
                RunState::Committing,
                RunState::Retrying,
            ],
        )
    }

    pub fn fail(&mut self) -> Result<(), TransitionError> {
        self.transition(
            RunState::Failed,
            &[
                RunState::Created,
                RunState::Preparing,
                RunState::Running,
                RunState::WaitingForApproval,
                RunState::WaitingForReconciliation,
                RunState::Committing,
                RunState::Retrying,
            ],
        )
    }

    pub fn complete(&mut self) -> Result<(), TransitionError> {
        self.transition(
            RunState::Completed,
            &[RunState::Running, RunState::Committing],
        )
    }

    fn transition(
        &mut self,
        target: RunState,
        allowed_sources: &[RunState],
    ) -> Result<(), TransitionError> {
        let source = self.state;
        if source.is_terminal() {
            return Err(TransitionError::TerminalState { source, target });
        }
        if !allowed_sources.contains(&source) {
            return Err(TransitionError::IllegalTransition { source, target });
        }
        self.state = target;
        Ok(())
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum TransitionError {
    IllegalTransition { source: RunState, target: RunState },
    TerminalState { source: RunState, target: RunState },
}

impl Display for TransitionError {
    fn fmt(&self, formatter: &mut Formatter<'_>) -> fmt::Result {
        match self {
            Self::IllegalTransition { source, target } => {
                write!(
                    formatter,
                    "illegal run transition: {source:?} -> {target:?}"
                )
            }
            Self::TerminalState { source, target } => {
                write!(
                    formatter,
                    "terminal run state rejects transition: {source:?} -> {target:?}"
                )
            }
        }
    }
}

impl Error for TransitionError {}

#[cfg(test)]
mod tests {
    use super::{RunState, RunStateMachine, TransitionError};

    type Transition = fn(&mut RunStateMachine) -> Result<(), TransitionError>;

    #[test]
    fn accepts_the_declared_transition_table() {
        let cases: &[(&[Transition], RunState)] = &[
            (&[RunStateMachine::prepare], RunState::Preparing),
            (
                &[RunStateMachine::prepare, RunStateMachine::start],
                RunState::Running,
            ),
            (
                &[
                    RunStateMachine::prepare,
                    RunStateMachine::start,
                    RunStateMachine::wait_for_approval,
                ],
                RunState::WaitingForApproval,
            ),
            (
                &[
                    RunStateMachine::prepare,
                    RunStateMachine::start,
                    RunStateMachine::wait_for_reconciliation,
                ],
                RunState::WaitingForReconciliation,
            ),
            (
                &[
                    RunStateMachine::prepare,
                    RunStateMachine::start,
                    RunStateMachine::begin_commit,
                ],
                RunState::Committing,
            ),
            (
                &[
                    RunStateMachine::prepare,
                    RunStateMachine::start,
                    RunStateMachine::retry,
                    RunStateMachine::prepare,
                ],
                RunState::Preparing,
            ),
            (
                &[
                    RunStateMachine::prepare,
                    RunStateMachine::start,
                    RunStateMachine::retry,
                    RunStateMachine::start,
                ],
                RunState::Running,
            ),
            (
                &[
                    RunStateMachine::prepare,
                    RunStateMachine::start,
                    RunStateMachine::complete,
                ],
                RunState::Completed,
            ),
        ];

        for (steps, expected) in cases {
            let mut machine = RunStateMachine::new();
            for step in *steps {
                step(&mut machine).expect("declared transition must be accepted");
            }
            assert_eq!(machine.state(), *expected);
        }
    }

    #[test]
    fn rejects_illegal_transitions_without_mutating_state() {
        let cases: &[(Transition, RunState)] = &[
            (RunStateMachine::start, RunState::Running),
            (
                RunStateMachine::wait_for_approval,
                RunState::WaitingForApproval,
            ),
            (RunStateMachine::begin_commit, RunState::Committing),
            (RunStateMachine::retry, RunState::Retrying),
            (RunStateMachine::complete, RunState::Completed),
        ];

        for (transition, target) in cases {
            let mut machine = RunStateMachine::new();
            assert_eq!(
                transition(&mut machine),
                Err(TransitionError::IllegalTransition {
                    source: RunState::Created,
                    target: *target,
                })
            );
            assert_eq!(machine.state(), RunState::Created);
        }
    }

    #[test]
    fn every_terminal_state_rejects_a_second_terminal() {
        let terminal_cases: &[(&[Transition], Transition, RunState)] = &[
            (
                &[RunStateMachine::prepare],
                RunStateMachine::block,
                RunState::Blocked,
            ),
            (&[], RunStateMachine::cancel, RunState::Cancelled),
            (&[], RunStateMachine::fail, RunState::Failed),
            (
                &[RunStateMachine::prepare, RunStateMachine::start],
                RunStateMachine::complete,
                RunState::Completed,
            ),
        ];

        for (setup, terminal, terminal_state) in terminal_cases {
            let mut machine = RunStateMachine::new();
            for step in *setup {
                step(&mut machine).unwrap();
            }
            terminal(&mut machine).unwrap();
            assert_eq!(
                machine.fail(),
                Err(TransitionError::TerminalState {
                    source: *terminal_state,
                    target: RunState::Failed,
                })
            );
            assert_eq!(machine.state(), *terminal_state);
        }
    }

    #[test]
    fn reconciliation_is_nonterminal_but_cannot_commit_or_complete_directly() {
        let mut machine = RunStateMachine::new();
        machine.prepare().unwrap();
        machine.start().unwrap();
        machine.wait_for_reconciliation().unwrap();
        assert!(!machine.state().is_terminal());
        assert!(matches!(
            machine.begin_commit(),
            Err(TransitionError::IllegalTransition {
                source: RunState::WaitingForReconciliation,
                target: RunState::Committing,
            })
        ));
        assert!(matches!(
            machine.complete(),
            Err(TransitionError::IllegalTransition {
                source: RunState::WaitingForReconciliation,
                target: RunState::Completed,
            })
        ));
        assert_eq!(machine.state(), RunState::WaitingForReconciliation);
        machine.retry().unwrap();
        assert_eq!(machine.state(), RunState::Retrying);
    }
}
