//! The fonts installed on this Mac, for choosing one to set subtitles in.

use objc2::MainThreadMarker;
use objc2_app_kit::NSFontManager;

/// Every font family a person would recognise, in alphabetical order.
/// Families whose names begin with a full stop are the system's private
/// ones, which macOS does not show in its own font lists either.
/// Must be called on the main thread.
pub fn font_families(main: MainThreadMarker) -> Vec<String> {
    let manager = NSFontManager::sharedFontManager(main);
    let mut families: Vec<String> = manager
        .availableFontFamilies()
        .iter()
        .map(|family| family.to_string())
        .filter(|family| !family.is_empty() && !family.starts_with('.'))
        .collect();
    families.sort_by_key(|family| family.to_lowercase());
    families.dedup();
    families
}
