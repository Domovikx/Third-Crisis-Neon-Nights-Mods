//! memstats.rs — пиковая память процесса (RSS) для честного бенчмарка.
//!
//! На Windows берём `PeakWorkingSetSize` через `K32GetProcessMemoryInfo`
//! (kernel32, без крейтов): Node не умеет отдавать пик дочернего процесса, а
//! мерить «на глазок» опросом `tasklist` — значит занижать пик. Отсюда —
//! маленький FFI прямо к системному вызову.
//!
//! На других ОС возвращаем `None`: сравнение в этой задаче — Windows-only.

#[cfg(windows)]
pub fn peak_rss_bytes() -> Option<u64> {
    #[repr(C)]
    struct ProcessMemoryCounters {
        cb: u32,
        page_fault_count: u32,
        peak_working_set_size: usize,
        working_set_size: usize,
        quota_peak_paged_pool_usage: usize,
        quota_paged_pool_usage: usize,
        quota_peak_non_paged_pool_usage: usize,
        quota_non_paged_pool_usage: usize,
        pagefile_usage: usize,
        peak_pagefile_usage: usize,
    }

    #[link(name = "kernel32")]
    extern "system" {
        fn GetCurrentProcess() -> isize;
        fn K32GetProcessMemoryInfo(
            process: isize,
            counters: *mut ProcessMemoryCounters,
            cb: u32,
        ) -> i32;
    }

    let mut counters = ProcessMemoryCounters {
        cb: std::mem::size_of::<ProcessMemoryCounters>() as u32,
        page_fault_count: 0,
        peak_working_set_size: 0,
        working_set_size: 0,
        quota_peak_paged_pool_usage: 0,
        quota_paged_pool_usage: 0,
        quota_peak_non_paged_pool_usage: 0,
        quota_non_paged_pool_usage: 0,
        pagefile_usage: 0,
        peak_pagefile_usage: 0,
    };
    // SAFETY: структура и её размер переданы согласованно; вызов только читает
    // счётчики текущего процесса.
    let ok = unsafe {
        K32GetProcessMemoryInfo(
            GetCurrentProcess(),
            &mut counters,
            std::mem::size_of::<ProcessMemoryCounters>() as u32,
        )
    };
    if ok != 0 {
        Some(counters.peak_working_set_size as u64)
    } else {
        None
    }
}

#[cfg(not(windows))]
pub fn peak_rss_bytes() -> Option<u64> {
    None
}
