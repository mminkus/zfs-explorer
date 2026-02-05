#![allow(non_upper_case_globals)]
#![allow(non_camel_case_types)]
#![allow(non_snake_case)]
#![allow(dead_code)]

mod bindings;

use std::ffi::{CStr, CString};
use std::sync::{Mutex, Once};

pub use bindings::*;

/// Global mutex around all FFI calls (per plan's concurrency model)
static FFI_MUTEX: Mutex<()> = Mutex::new(());

/// Ensure zdx_init() is called exactly once
static INIT: Once = Once::new();

/// Initialize ZFS library (called once via std::sync::Once)
pub fn init() -> Result<(), String> {
    let mut result = Ok(());

    INIT.call_once(|| {
        let _lock = FFI_MUTEX.lock().unwrap();
        let rc = unsafe { zdx_init() };
        if rc != 0 {
            result = Err(format!("zdx_init failed with code {}", rc));
        }
    });

    result
}

/// Safe wrapper for zdx_result_t
pub struct ZdxResult {
    inner: zdx_result_t,
}

impl ZdxResult {
    /// Create from raw zdx_result_t (takes ownership)
    pub fn from_raw(raw: zdx_result_t) -> Self {
        ZdxResult { inner: raw }
    }

    /// Check if result is successful
    pub fn is_ok(&self) -> bool {
        self.inner.err == 0
    }

    /// Get JSON string (if available)
    pub fn json(&self) -> Option<&str> {
        if self.inner.json.is_null() {
            return None;
        }
        unsafe { CStr::from_ptr(self.inner.json).to_str().ok() }
    }

    /// Get error message (if available)
    pub fn error_msg(&self) -> Option<&str> {
        if self.inner.errmsg.is_null() {
            return None;
        }
        unsafe { CStr::from_ptr(self.inner.errmsg).to_str().ok() }
    }

    /// Get error code
    pub fn error_code(&self) -> i32 {
        self.inner.err
    }
}

impl Drop for ZdxResult {
    fn drop(&mut self) {
        let _lock = FFI_MUTEX.lock().unwrap();
        unsafe { zdx_free_result(&mut self.inner) };
    }
}

/// List all pools (behind mutex)
pub fn list_pools() -> ZdxResult {
    let _lock = FFI_MUTEX.lock().unwrap();
    let raw = unsafe { zdx_list_pools() };
    ZdxResult::from_raw(raw)
}

/// Get version string
pub fn version() -> &'static str {
    let _lock = FFI_MUTEX.lock().unwrap();
    let cstr = unsafe { CStr::from_ptr(zdx_version()) };
    cstr.to_str().unwrap_or("unknown")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_version() {
        let ver = version();
        assert!(!ver.is_empty());
    }
}
