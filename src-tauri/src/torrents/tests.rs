use super::*;

fn file(index: u32, name: &str) -> TorrentFile {
    file_of(index, name, 1)
}

#[test]
fn search_results_need_a_hash_a_name_and_a_magnet() {
    let search: wire::Search = serde_json::from_str(
        r#"{"results":[
            {"name":"Big Buck Bunny","infoHash":"C39FE3EEFBDB62DA9C27EB6398FF4A7D2E26E7AB",
             "magnet":"magnet:?xt=urn:btih:c39f","size":"175 MB","seeders":12,"leechers":3,
             "uploaded":"2010-01-28T00:00:00Z","trusted":true,"category":"Video"},
            {"name":"","infoHash":"c39fe3eefbdb62da9c27eb6398ff4a7d2e26e7ab","magnet":"magnet:?x"},
            {"name":"Short hash","infoHash":"abc","magnet":"magnet:?x"},
            {"name":"No magnet","infoHash":"c39fe3eefbdb62da9c27eb6398ff4a7d2e26e7ab"}
        ]}"#,
    )
    .unwrap();
    let results: Vec<_> = search
        .results
        .into_iter()
        .filter_map(wire::Found::into_result)
        .collect();
    assert_eq!(results.len(), 1);
    let found = &results[0];
    assert_eq!(found.hash, "c39fe3eefbdb62da9c27eb6398ff4a7d2e26e7ab");
    assert_eq!(found.uploaded.as_deref(), Some("2010-01-28"));
    assert_eq!(
        (found.seeders, found.leechers, found.trusted),
        (12, 3, true)
    );
    assert_eq!(found.ready, None);
}

#[test]
fn a_finished_torrent_lists_its_files_by_their_own_names() {
    let item: wire::Item = serde_json::from_str(
        r#"{"name":"Show S01","status":"downloaded","progress":100,"links":[
            {"url":"/dl/tb-x/0","filename":"Show S01/Show.S01E10.mkv","size":200},
            {"url":"/dl/tb-x/1","filename":"Show S01/Show.S01E02.mkv","size":100},
            {"url":"/dl/tb-x/2","filename":"Show S01/Sample/sample.mkv","size":5},
            {"url":"/dl/tb-x/3","filename":"Show S01/Show.S01E02.srt","size":1}
        ]}"#,
    )
    .unwrap();
    let TorrentProgress::Ready { name, files } = item.into_progress() else {
        panic!("should be ready");
    };
    assert_eq!(name, "Show S01");
    let names: Vec<_> = files
        .iter()
        .map(|file| (file.index, file.name.as_str(), file.playable))
        .collect();
    assert_eq!(
        names,
        [
            (0, "Show.S01E10.mkv", true),
            (1, "Show.S01E02.mkv", true),
            (2, "sample.mkv", false),
            (3, "Show.S01E02.srt", false),
        ]
    );
}

#[test]
fn an_unfinished_or_failed_torrent_says_so() {
    let working: wire::Item = serde_json::from_str(
        r#"{"name":"A","status":"downloading","progress":140,"speed":-1,"seeders":4}"#,
    )
    .unwrap();
    assert_eq!(
        working.into_progress(),
        TorrentProgress::Working {
            name: "A".to_owned(),
            state: "downloading".to_owned(),
            progress: 100.0,
            speed: 0.0,
            seeders: 4,
        }
    );
    let failed: wire::Item =
        serde_json::from_str(r#"{"status":"unavailable","error":"These files are gone."}"#)
            .unwrap();
    assert_eq!(
        failed.into_progress(),
        TorrentProgress::Failed {
            message: "These files are gone.".to_owned()
        }
    );
}

#[test]
fn choosing_an_episode_queues_it_and_those_after_it() {
    let files = [
        file(0, "Show.S01E10.mkv"),
        file(1, "Show.S01E02.mkv"),
        file(2, "Show.S01E01.mkv"),
        file(3, "notes.txt"),
    ];
    let queued: Vec<_> = queue_from(&files, 1)
        .iter()
        .map(|file| file.index)
        .collect();
    assert_eq!(queued, [1, 0]);
    let first: Vec<_> = queue_from(&files, 2)
        .iter()
        .map(|file| file.index)
        .collect();
    assert_eq!(first, [2, 1, 0]);
    assert_eq!(title_of(&files[0]), "Show.S01E10");
}

#[test]
fn ids_and_addresses_are_checked() {
    let torrents = Torrents::new("https://example.test/");
    let id = "tb-c39fe3eefbdb62da9c27eb6398ff4a7d2e26e7ab";
    assert_eq!(
        torrents.address(id, 3).unwrap(),
        format!("https://example.test/dl/{id}/3")
    );
    assert!(torrents.address("tb-../../x", 0).is_err());
    assert!(torrents
        .address("c39fe3eefbdb62da9c27eb6398ff4a7d2e26e7ab", 0)
        .is_err());
}

#[test]
fn queries_are_encoded() {
    assert_eq!(encode("the matrix 1999"), "the%20matrix%201999");
    assert_eq!(encode("amélie & co"), "am%C3%A9lie%20%26%20co");
}

#[test]
fn only_what_is_ready_is_offered() {
    let result = |hash: char, seeders: u32| TorrentResult {
        name: format!("R{hash}"),
        hash: hash.to_string().repeat(40),
        magnet: "magnet:?x".to_owned(),
        size: String::new(),
        seeders,
        leechers: 0,
        uploaded: None,
        category: None,
        trusted: false,
        ready: None,
    };
    let ready = [("a".repeat(40), true), ("b".repeat(40), false)]
        .into_iter()
        .collect();
    let kept = only_ready(
        vec![result('a', 9), result('b', 50), result('c', 3)],
        &ready,
    );
    assert_eq!(kept.len(), 1);
    assert_eq!((kept[0].name.as_str(), kept[0].ready), ("Ra", Some(true)));
}

#[test]
fn full_hd_is_known_by_its_name() {
    assert!(is_full_hd("MobLand S02E10 1080p AMZN WEB-DL"));
    assert!(is_full_hd("Film.2019.2160p.UHD.BluRay"));
    assert!(is_full_hd("Film 2019 [4K]"));
    assert!(!is_full_hd("MobLand S02E10 720p AMZN WEB-DL"));
    assert!(!is_full_hd("Film 2019 x264-10800p"));
}
