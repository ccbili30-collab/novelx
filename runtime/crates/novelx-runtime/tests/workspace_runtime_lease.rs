use std::fs;

use novelx_runtime::workspace_runtime_lease::{WorkspaceRuntimeLease, WorkspaceRuntimeLeaseError};

#[test]
fn lease_blocks_a_second_owner_and_releases_on_drop() {
    let temp = tempfile::tempdir().unwrap();
    let database = temp.path().join("workspace.db");
    let first = WorkspaceRuntimeLease::acquire(&database, "instance-1").unwrap();
    let first_owner = first.instance_id().to_owned();
    let first_epoch = first.lease_epoch().to_owned();
    assert_eq!(first.instance_label(), "instance-1");
    assert!(first.proves_exclusive_owner(&first_owner));
    assert!(!first.proves_exclusive_owner("instance-1"));
    assert!(!first.proves_exclusive_owner("instance-2"));
    assert!(matches!(
        WorkspaceRuntimeLease::acquire(&database, "instance-2"),
        Err(WorkspaceRuntimeLeaseError::AlreadyHeld { .. })
    ));
    let lock_path = first.lock_path().to_owned();
    drop(first);
    let metadata: serde_json::Value =
        serde_json::from_str(&fs::read_to_string(lock_path).unwrap()).unwrap();
    assert_eq!(metadata["schemaVersion"], 2);
    assert_eq!(metadata["instanceId"], first_owner);
    assert_eq!(metadata["instanceLabel"], "instance-1");
    assert_eq!(metadata["leaseEpoch"], first_epoch);
    assert_eq!(metadata["processId"], std::process::id());

    let second = WorkspaceRuntimeLease::acquire(&database, "instance-1").unwrap();
    assert_eq!(second.instance_label(), "instance-1");
    assert!(second.proves_exclusive_owner(second.instance_id()));
    assert_ne!(second.instance_id(), first_owner);
    assert!(!second.proves_exclusive_owner(&first_owner));
}

#[test]
fn invalid_owner_or_parent_fails_before_locking() {
    let temp = tempfile::tempdir().unwrap();
    let database = temp.path().join("workspace.db");
    assert!(matches!(
        WorkspaceRuntimeLease::acquire(&database, "  "),
        Err(WorkspaceRuntimeLeaseError::InstanceIdRequired)
    ));
    assert!(matches!(
        WorkspaceRuntimeLease::acquire(temp.path().join("missing").join("workspace.db"), "one"),
        Err(WorkspaceRuntimeLeaseError::DatabaseParentMissing)
    ));
}
