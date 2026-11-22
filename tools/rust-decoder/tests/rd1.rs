//! rd1.rs — интеграционная проверка формата на синтетических фикстурах.
//!
//! Здесь проверяется то, что видит потребитель (TS-адаптер): записи идут в
//! ожидаемом порядке, имена полей и порядок ключей совпадают с эталоном, байты
//! объектов приходят base64, а не-UText-файлы (`.resource`, DLL) отдают только
//! свои сканы. Файлов игры в тестах нет.

use rust_decoder::json::Out;
use rust_decoder::rd1::{emit_file, Timings};
use rust_decoder::testkit::{
    build_blocks_info, build_serialized_file, build_unityfs, BuildUnityFs, SerializedFixture,
};

fn emit(asset: &str, path: &str, bytes: &[u8]) -> String {
    let mut out = Out::new(Vec::new());
    emit_file(&mut out, asset, path, bytes, &mut Timings::default()).expect("запись не падает");
    String::from_utf8(out.finish().unwrap()).unwrap()
}

/// Type tree: корень + одно строковое поле (как MonoBehaviour с m_Name).
fn type_tree() -> (Vec<u8>, Vec<u8>) {
    let strings = b"string\0m_Name\0\0\0\0".to_vec();
    let mut node = vec![0u8; 32];
    node[4..8].copy_from_slice(&0u32.to_le_bytes()); // typeOffset = "string"
    node[8..12].copy_from_slice(&7u32.to_le_bytes()); // nameOffset = "m_Name"
    node[12..16].copy_from_slice(&(-1i32).to_le_bytes()); // byteSize
    let mut root = vec![0u8; 32];
    root[4..8].copy_from_slice(&0u32.to_le_bytes());
    // level=0 у корня, level=1 у поля
    node[2] = 1;
    let mut nodes = root;
    nodes.extend_from_slice(&node);
    (nodes, strings)
}

#[test]
fn ассет_без_type_tree_даёт_объекты_и_сканы() {
    let dialogue = b"x{\"Speaker\":\"Zoey\",\"Text\":\"Hi <b>there</b>!\"}".to_vec();
    let bytes = build_serialized_file(&SerializedFixture {
        enable_type_tree: false,
        types: vec![(114, None)],
        objects: vec![(42, 0, dialogue)],
    });
    let text = emit("level_x", "C:/game/level_x", &bytes);
    let lines: Vec<&str> = text.lines().collect();
    assert!(lines[0].contains("\"t\":\"asset\""));
    assert!(lines[0].contains("\"kind\":\"serialized\""));
    assert!(lines[1].starts_with("{\"t\":\"sf\",\"i\":0,"));
    assert!(lines[1].contains("\"typeTreeEnabled\":false"));
    let obj = lines[2];
    assert!(
        obj.starts_with("{\"t\":\"obj\",\"sf\":0,\"typeId\":0,\"classId\":114,\"pathId\":\"42\"")
    );
    assert!(
        obj.contains("\"rs\":[\"x{\\\"Speaker"),
        "raw-строки объекта: {}",
        obj
    );
    assert!(
        obj.contains("\"dl\":[{\"offset\":2,\"speaker\":\"Zoey\",\"text\":\"Hi there!\""),
        "{}",
        obj
    );
    assert!(
        !obj.contains("\"raw\":"),
        "байты объекта не нужны без type tree"
    );
}

#[test]
fn бандл_отдаёт_entries_sf_type_tree_и_байты_объекта() {
    let (nodes, strings) = type_tree();
    // m_Name = "FSM": length(4) + "FSM" + pad(1) → 8 байт.
    let mut data = vec![3, 0, 0, 0, b'F', b'S', b'M', 0];
    data.push(0);
    let serialized = build_serialized_file(&SerializedFixture {
        enable_type_tree: true,
        types: vec![(114, Some((nodes, strings)))],
        objects: vec![(7, 0, data)],
    });
    let blocks_info = build_blocks_info(
        &[(serialized.len() as u32, serialized.len() as u32, 0)],
        &[("CAB-x", 0, serialized.len())],
    );
    let bundle = build_unityfs(&BuildUnityFs {
        blocks_info: &blocks_info,
        blocks: vec![(serialized.clone(), 0, serialized.len())],
        flags: 0x40,
        engine_version: "2022.3.62f3",
        format_version: 8,
        blocks_info_at_end: false,
    });
    let text = emit("bundle_x", "C:/game/bundle_x", &bundle);
    let lines: Vec<&str> = text.lines().collect();
    assert!(lines[0].contains("\"kind\":\"unityfs\""));
    assert!(lines[0].contains("\"entries\":[{\"path\":\"CAB-x\",\"offset\":0,"));
    assert!(lines[1].starts_with("{\"t\":\"sf\",\"i\":0,\"name\":\"CAB-x\","));
    assert!(lines[2].starts_with("{\"t\":\"type\",\"sf\":0,\"typeId\":0,\"classId\":114,"));
    let obj = lines[3];
    assert!(
        obj.contains("\"raw\":\""),
        "типизированный объект несёт байты: {}",
        obj
    );
    // base64 от 9 байт [03 00 00 00 46 53 4d 00 00] = 12 символов с паддингом.
    assert!(obj.contains("\"raw\":\"AwAAAEZTTQAA\""), "{}", obj);
}

#[test]
fn resource_отдаёт_ключи_и_печатные_строки() {
    let mut bytes = vec![0xaa, 0xbb, 0xcc, 0xdd];
    let key = b"Settings.EnableVSync";
    bytes.extend_from_slice(&(key.len() as u32).to_le_bytes());
    bytes.extend_from_slice(key);
    bytes.push(0);
    let display = b"Enable VSync";
    bytes.extend_from_slice(&(display.len() as u32).to_le_bytes());
    bytes.extend_from_slice(display);
    bytes.push(0);
    bytes.extend_from_slice(b"New Game");
    let text = emit("resource_x", "C:/game/x.resource", &bytes);
    let lines: Vec<&str> = text.lines().collect();
    assert!(lines[0].contains("\"kind\":\"raw\""));
    // runs идут ДО keys: адаптер фильтрует global_strings по настройкам.
    assert!(lines[1].starts_with("{\"t\":\"runs\",\"texts\":["));
    assert!(lines[2].starts_with("{\"t\":\"keys\",\"keys\":[{\"key\":\"Settings.EnableVSync\","));
}

#[test]
fn неизвестный_файл_не_падает() {
    let text = emit("misc", "C:/game/misc.bin", b"\x00\x01\x02");
    assert!(text.contains("\"kind\":\"unknown\""));
    assert_eq!(text.lines().count(), 1);
}

#[test]
fn битый_unityfs_даёт_ошибку_вместо_падения() {
    let text = emit("broken", "C:/game/broken.bundle", b"UnityFS\x00\x00");
    assert!(text.contains("\"error\":"), "{}", text);
    assert_eq!(text.lines().count(), 1);
}
