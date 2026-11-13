use tauri::{WebviewWindow, window::Color};

// Windows COLORREF is 0x00BBGGRR, unlike the theme's #RRGGBB.
#[cfg(any(windows, test))]
fn color_ref(color: Color) -> u32 {
    u32::from_le_bytes([color.0, color.1, color.2, 0])
}

/// Tauri's transparent title bar is macOS-only. Windows 11 needs DWM colors
/// for the native caption; changing the client-area background is not enough.
#[tauri::command]
pub fn set_title_bar_color(window: WebviewWindow, color: Color) -> Result<(), String> {
    #[cfg(windows)]
    {
        use windows::Win32::{
            Foundation::COLORREF,
            Graphics::Dwm::{DWMWA_CAPTION_COLOR, DWMWA_TEXT_COLOR, DwmSetWindowAttribute},
        };

        let hwnd = window.hwnd().map_err(|error| error.to_string())?;
        for (attribute, value) in [
            (DWMWA_CAPTION_COLOR, COLORREF(color_ref(color))),
            // All header palettes use white foregrounds, including light themes.
            (DWMWA_TEXT_COLOR, COLORREF(0x00ff_ffff)),
        ] {
            // SAFETY: hwnd belongs to this live Tauri window. DWM reads the
            // COLORREF synchronously, with its exact size and matching attribute.
            unsafe {
                DwmSetWindowAttribute(
                    hwnd,
                    attribute,
                    (&value as *const COLORREF).cast(),
                    std::mem::size_of::<COLORREF>() as u32,
                )
            }
            .map_err(|error| format!("Could not set title bar color: {error}"))?;
        }
    }
    #[cfg(not(windows))]
    let _ = (window, color);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn theme_colors_use_windows_bgr_byte_order_without_alpha() {
        for (hex, expected) in [
            ("#4565ed", 0x00ed_6545),
            ("#246957", 0x0057_6924),
            ("#aa553b", 0x003b_55aa),
            ("#292542", 0x0042_2529),
        ] {
            let color: Color = serde_json::from_value(serde_json::json!(hex)).unwrap();
            assert_eq!(color_ref(color), expected);
        }
        assert_eq!(color_ref(Color(0x12, 0x34, 0x56, 0x78)), 0x0056_3412);
    }
}
