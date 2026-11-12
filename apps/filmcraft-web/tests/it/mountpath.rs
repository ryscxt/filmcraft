//! Where a host may mount server files (`filmcraft.mountUrl`). Runs natively even though the
//! rest of the crate is wasm32-only.

#[path = "../../src/mountpath.rs"]
mod rules;

use rules::{URL_PATH_MAX, url_path_ok};

#[test]
fn mounts_stay_inside_the_media_folder() {
    assert!(url_path_ok("/files/clip.mp4").is_ok());
    assert!(url_path_ok("/files/Trailer/Day 1/clip 01.mov").is_ok());
    for bad in [
        "/files/",
        "/files//a.mp4",
        "/files/a/",
        "/files/../etc/passwd",
        "/files/a/./b.mp4",
        "/files/a/../../b",
        "/projects/a.fcproj",
        "files/a.mp4",
        "/files/a\\b.mp4",
        "/files/a\0.mp4",
        "",
    ] {
        assert!(url_path_ok(bad).is_err(), "{bad:?} must be refused");
    }
}

#[test]
fn mount_paths_are_bounded() {
    let long = format!("/files/{}", "a".repeat(URL_PATH_MAX));
    assert!(url_path_ok(&long).is_err());
    let fits = format!("/files/{}", "a".repeat(URL_PATH_MAX - "/files/".len()));
    assert!(url_path_ok(&fits).is_ok());
}
