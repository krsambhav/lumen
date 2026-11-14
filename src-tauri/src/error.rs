//! The one error type that crosses the IPC boundary.
//!
//! Every command returns `AppResult<T>`. The frontend receives the error as
//! `{ kind, message }`, so it can branch on `kind` and show `message`.

use serde::Serialize;
use specta::Type;

#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error, Serialize, Type)]
#[serde(tag = "kind", content = "message", rename_all = "camelCase")]
pub enum AppError {
    /// The settings or library database could not be read or written.
    #[error("{0}")]
    Database(String),
    /// A file or directory operation failed.
    #[error("{0}")]
    Io(String),
    /// Something the caller asked for does not exist.
    #[error("{0}")]
    NotFound(String),
    /// The caller passed a value that cannot be used.
    #[error("{0}")]
    Invalid(String),
    /// There is already something by that name.
    #[error("{0}")]
    Exists(String),
    /// The playback engine reported a failure.
    #[error("{0}")]
    Engine(String),
    /// The operation is not available on this system or for this media.
    #[error("{0}")]
    Unsupported(String),
    /// A network request or cast device failed.
    #[error("{0}")]
    Network(String),
    /// A bug in Lumen. The message is for the log, not for the user.
    #[error("{0}")]
    Internal(String),
}

pub type AppResult<T> = Result<T, AppError>;

impl From<rusqlite::Error> for AppError {
    fn from(error: rusqlite::Error) -> Self {
        Self::Database(error.to_string())
    }
}

impl From<std::io::Error> for AppError {
    fn from(error: std::io::Error) -> Self {
        match error.kind() {
            std::io::ErrorKind::NotFound => Self::NotFound(error.to_string()),
            _ => Self::Io(error.to_string()),
        }
    }
}

impl From<serde_json::Error> for AppError {
    fn from(error: serde_json::Error) -> Self {
        Self::Internal(format!("serialisation failed: {error}"))
    }
}

impl From<tauri::Error> for AppError {
    fn from(error: tauri::Error) -> Self {
        Self::Internal(error.to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn serialises_as_kind_and_message() {
        let json = serde_json::to_value(AppError::NotFound("no such file".into())).unwrap();
        assert_eq!(
            json,
            serde_json::json!({ "kind": "notFound", "message": "no such file" })
        );
    }

    #[test]
    fn missing_files_map_to_not_found() {
        let io = std::io::Error::new(std::io::ErrorKind::NotFound, "gone");
        assert!(matches!(AppError::from(io), AppError::NotFound(_)));
        let io = std::io::Error::new(std::io::ErrorKind::PermissionDenied, "denied");
        assert!(matches!(AppError::from(io), AppError::Io(_)));
    }
}
