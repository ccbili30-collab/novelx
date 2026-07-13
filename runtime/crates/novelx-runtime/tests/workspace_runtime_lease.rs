use std::{fs, sync::Arc};

use novelx_runtime::workspace_runtime_lease::{
    BoundWorkspaceRuntimeLease, BoundWorkspaceRuntimeLeaseError, WorkspaceRuntimeLease,
    WorkspaceRuntimeLeaseError,
};
use rusqlite::Connection;

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

#[cfg(windows)]
#[test]
fn active_sidecar_lock_cannot_be_renamed_deleted_or_recreated_on_windows() {
    let temp = tempfile::tempdir().unwrap();
    let database = temp.path().join("workspace.db");
    let lease = WorkspaceRuntimeLease::acquire(&database, "sidecar-owner").unwrap();
    let lock_path = lease.lock_path().to_owned();
    let displaced = temp.path().join("displaced.runtime.lock");

    assert!(fs::rename(&lock_path, &displaced).is_err());
    assert!(fs::remove_file(&lock_path).is_err());
    assert!(matches!(
        WorkspaceRuntimeLease::acquire(&database, "split-brain-attempt"),
        Err(WorkspaceRuntimeLeaseError::AlreadyHeld { .. })
    ));
    assert!(lock_path.is_file());

    drop(lease);
    fs::rename(&lock_path, &displaced).unwrap();
    let successor = WorkspaceRuntimeLease::acquire(&database, "sidecar-successor").unwrap();
    assert!(successor.lock_path().is_file());
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

#[test]
fn database_binding_is_two_phase_typed_and_preserves_lease_authority() {
    assert_send_sync::<WorkspaceRuntimeLease>();
    assert_send_sync::<BoundWorkspaceRuntimeLease>();

    let temp = tempfile::tempdir().unwrap();
    let missing = temp.path().join("missing.db");
    let missing_lease = WorkspaceRuntimeLease::acquire(&missing, "missing").unwrap();
    assert!(matches!(
        missing_lease.bind_database(&missing),
        Err(BoundWorkspaceRuntimeLeaseError::DatabaseFileMissing { .. })
    ));

    let directory = temp.path().join("directory.db");
    fs::create_dir(&directory).unwrap();
    let directory_lease = WorkspaceRuntimeLease::acquire(&directory, "directory").unwrap();
    assert!(matches!(
        directory_lease.bind_database(&directory),
        Err(BoundWorkspaceRuntimeLeaseError::DatabasePathNotRegularFile { .. })
    ));

    let database = temp.path().join("workspace.db");
    create_database(&database);
    let mismatch_lease = WorkspaceRuntimeLease::acquire(&database, "mismatch").unwrap();
    assert!(matches!(
        mismatch_lease.bind_database(temp.path().join("other.db")),
        Err(BoundWorkspaceRuntimeLeaseError::WorkspaceLeasePathMismatch { .. })
    ));

    let lease = WorkspaceRuntimeLease::acquire(&database, "bound-owner").unwrap();
    let owner_id = lease.instance_id().to_owned();
    let lease_epoch = lease.lease_epoch().to_owned();
    let bound = Arc::new(lease.bind_database(&database).unwrap());
    assert_eq!(bound.database_path(), fs::canonicalize(&database).unwrap());
    assert_eq!(bound.owner_id(), owner_id);
    assert_eq!(bound.lease_epoch(), lease_epoch);
    assert_eq!(bound.instance_label(), "bound-owner");
    assert!(bound.proves_exclusive_owner(&owner_id));
    bound.verify_owner(&owner_id).unwrap();
    bound.verify_lease_epoch(&lease_epoch).unwrap();
    bound.verify_database_file_current().unwrap();
    assert!(matches!(
        bound.verify_owner("wrong-owner"),
        Err(BoundWorkspaceRuntimeLeaseError::LeaseOwnerMismatch { .. })
    ));
    assert!(matches!(
        bound.verify_lease_epoch("wrong-epoch"),
        Err(BoundWorkspaceRuntimeLeaseError::LeaseEpochMismatch { .. })
    ));
    assert!(matches!(
        bound.verify_database_path(temp.path().join("absent.db")),
        Err(BoundWorkspaceRuntimeLeaseError::DatabaseFileMissing { .. })
    ));
    assert_eq!(Arc::strong_count(&bound), 1);
    let shared = Arc::clone(&bound);
    assert_eq!(Arc::strong_count(&bound), 2);
    shared.verify_database_file_current().unwrap();
}

#[cfg(any(windows, unix))]
#[test]
fn copied_database_has_a_distinct_identity_and_replacement_is_fenced() {
    let temp = tempfile::tempdir().unwrap();
    let database = temp.path().join("workspace.db");
    let replacement = temp.path().join("replacement.db");
    let displaced = temp.path().join("displaced.db");
    create_database(&database);
    fs::copy(&database, &replacement).unwrap();

    let lease = WorkspaceRuntimeLease::acquire(&database, "original").unwrap();
    let bound = lease.bind_database(&database).unwrap();
    let original_identity = bound.database_file_identity_sha256().to_owned();

    let replacement_lease = WorkspaceRuntimeLease::acquire(&replacement, "replacement").unwrap();
    let replacement_bound = replacement_lease.bind_database(&replacement).unwrap();
    let replacement_identity = replacement_bound.database_file_identity_sha256().to_owned();
    assert_ne!(original_identity, replacement_identity);
    assert!(matches!(
        bound.verify_database_path(&replacement),
        Err(BoundWorkspaceRuntimeLeaseError::DatabaseFileReplaced { .. })
    ));
    drop(replacement_bound);

    #[cfg(windows)]
    {
        assert!(fs::rename(&database, &displaced).is_err());
        bound.verify_database_file_current().unwrap();
    }
    #[cfg(unix)]
    {
        fs::rename(&database, &displaced).unwrap();
        fs::rename(&replacement, &database).unwrap();
        assert!(matches!(
            bound.verify_database_file_current(),
            Err(BoundWorkspaceRuntimeLeaseError::DatabaseFileReplaced { .. })
        ));
    }

    drop(bound);
    #[cfg(windows)]
    {
        fs::rename(&database, &displaced).unwrap();
        fs::rename(&replacement, &database).unwrap();
    }
    let rebound_lease = WorkspaceRuntimeLease::acquire(&database, "rebound").unwrap();
    let rebound = rebound_lease.bind_database(&database).unwrap();
    assert_ne!(rebound.database_file_identity_sha256(), original_identity);
    assert_eq!(
        rebound.database_file_identity_sha256(),
        replacement_identity
    );
    rebound.verify_database_file_current().unwrap();
}

#[test]
fn hard_link_alias_cannot_bind_the_same_database_identity_twice() {
    let temp = tempfile::tempdir().unwrap();
    let database = temp.path().join("workspace.db");
    let alias = temp.path().join("workspace-alias.db");
    create_database(&database);
    if let Err(error) = fs::hard_link(&database, &alias) {
        if matches!(
            error.kind(),
            std::io::ErrorKind::Unsupported | std::io::ErrorKind::PermissionDenied
        ) || (cfg!(windows) && error.raw_os_error() == Some(1314))
        {
            return;
        }
        panic!("failed to create hard-link fixture: {error}");
    }
    let lease = WorkspaceRuntimeLease::acquire(&database, "original-path").unwrap();
    let alias_lease = WorkspaceRuntimeLease::acquire(&alias, "hard-link-path").unwrap();
    let bound = lease.bind_database(&database).unwrap();
    let identity = bound.database_file_identity_sha256().to_owned();
    let identity_lock_path = bound.database_identity_lock_path().to_owned();
    bound.verify_database_path(&alias).unwrap();
    assert!(matches!(
        alias_lease.bind_database(&alias),
        Err(BoundWorkspaceRuntimeLeaseError::DatabaseIdentityAlreadyBound {
            database_file_identity_sha256,
            lock_path,
        }) if database_file_identity_sha256 == identity && lock_path == identity_lock_path
    ));

    drop(bound);
    let successor_lease = WorkspaceRuntimeLease::acquire(&alias, "hard-link-successor").unwrap();
    let successor = successor_lease.bind_database(&alias).unwrap();
    assert_eq!(successor.database_file_identity_sha256(), identity);
    assert_eq!(successor.database_identity_lock_path(), identity_lock_path);
}

#[cfg(any(windows, unix))]
#[test]
fn symbolic_link_alias_cannot_bind_the_same_database_identity_twice_when_supported() {
    let temp = tempfile::tempdir().unwrap();
    let database = temp.path().join("workspace.db");
    let alias = temp.path().join("workspace-symlink.db");
    create_database(&database);
    if let Err(error) = create_file_symlink(&database, &alias) {
        if matches!(
            error.kind(),
            std::io::ErrorKind::Unsupported | std::io::ErrorKind::PermissionDenied
        ) || (cfg!(windows) && error.raw_os_error() == Some(1314))
        {
            return;
        }
        panic!("failed to create symbolic-link fixture: {error}");
    }

    let lease = WorkspaceRuntimeLease::acquire(&database, "original-path").unwrap();
    let alias_lease = WorkspaceRuntimeLease::acquire(&alias, "symlink-path").unwrap();
    let bound = lease.bind_database(&database).unwrap();
    let identity = bound.database_file_identity_sha256().to_owned();
    assert!(matches!(
        alias_lease.bind_database(&alias),
        Err(BoundWorkspaceRuntimeLeaseError::DatabaseIdentityAlreadyBound {
            database_file_identity_sha256,
            ..
        }) if database_file_identity_sha256 == identity
    ));
}

#[test]
fn wal_checkpoint_and_vacuum_preserve_main_database_identity() {
    let temp = tempfile::tempdir().unwrap();
    let database = temp.path().join("workspace.db");
    create_database(&database);
    let lease = WorkspaceRuntimeLease::acquire(&database, "sqlite-maintenance").unwrap();
    let bound = lease.bind_database(&database).unwrap();
    let identity = bound.database_file_identity_sha256().to_owned();

    let connection = Connection::open(&database).unwrap();
    let journal_mode: String = connection
        .query_row("PRAGMA journal_mode=WAL", [], |row| row.get(0))
        .unwrap();
    assert_eq!(journal_mode.to_ascii_lowercase(), "wal");
    connection
        .execute("INSERT INTO identity_test(value) VALUES ('wal')", [])
        .unwrap();
    connection
        .execute_batch("PRAGMA wal_checkpoint(TRUNCATE);")
        .unwrap();
    bound.verify_database_file_current().unwrap();
    connection.execute_batch("VACUUM;").unwrap();
    bound.verify_database_file_current().unwrap();
    assert_eq!(bound.database_file_identity_sha256(), identity);
}

#[cfg(windows)]
#[test]
fn inaccessible_database_identity_is_a_typed_failure() {
    use std::{fs::OpenOptions, os::windows::fs::OpenOptionsExt};

    let temp = tempfile::tempdir().unwrap();
    let database = temp.path().join("workspace.db");
    create_database(&database);
    let lease = WorkspaceRuntimeLease::acquire(&database, "exclusive").unwrap();
    let exclusive = OpenOptions::new()
        .read(true)
        .write(true)
        .share_mode(0)
        .open(&database)
        .unwrap();
    assert!(matches!(
        lease.bind_database(&database),
        Err(BoundWorkspaceRuntimeLeaseError::DatabaseFileIdentityUnavailable { .. })
    ));
    drop(exclusive);
}

fn create_database(path: &std::path::Path) {
    let connection = Connection::open(path).unwrap();
    connection
        .execute_batch(
            "CREATE TABLE identity_test (id INTEGER PRIMARY KEY, value TEXT NOT NULL);\
             INSERT INTO identity_test(value) VALUES ('original');",
        )
        .unwrap();
}

fn assert_send_sync<T: Send + Sync>() {}

#[cfg(windows)]
fn create_file_symlink(original: &std::path::Path, alias: &std::path::Path) -> std::io::Result<()> {
    std::os::windows::fs::symlink_file(original, alias)
}

#[cfg(unix)]
fn create_file_symlink(original: &std::path::Path, alias: &std::path::Path) -> std::io::Result<()> {
    std::os::unix::fs::symlink(original, alias)
}
