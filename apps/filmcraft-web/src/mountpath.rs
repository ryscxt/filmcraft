//! The rule for where a host may mount a server file in the virtual file table
//! ([`crate::fs::register_url`]). Pure, so it is tested natively (`tests/it/mountpath.rs`).

/// Longest virtual path a mount accepts.
pub const URL_PATH_MAX: usize = 4096;

/// A mount path: absolute, under `/files/`, with no empty, `.` or `..` segment, no backslash or
/// NUL, and at most [`URL_PATH_MAX`] bytes. Saved projects refer to media by these paths, so they
/// must stay inside the media folder the Media Browser shows.
pub fn url_path_ok(path: &str) -> Result<(), String> {
    let Some(rest) = path.strip_prefix("/files/") else { return Err(format!("{path}: a mounted file must live under /files/")) };
    if path.len() > URL_PATH_MAX || path.contains('\\') || path.contains('\0') {
        return Err("not a usable path".to_string());
    }
    if rest.split('/').any(|seg| seg.is_empty() || seg == "." || seg == "..") {
        return Err(format!("{path}: not a usable path"));
    }
    Ok(())
}
