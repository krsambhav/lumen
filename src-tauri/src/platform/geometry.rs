//! Window geometry that does not depend on any windowing API, so it can be
//! tested: where a window should sit to show a picture without bars.

/// A rectangle in screen points. `y` grows upward on macOS; nothing here
/// depends on that.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Rect {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

impl Rect {
    fn center(&self) -> (f64, f64) {
        (self.x + self.width / 2.0, self.y + self.height / 2.0)
    }
}

/// The frame a window should take so that a `video` picture (width, height,
/// in any unit) fills it exactly.
///
/// The window keeps its width where it can and changes height to match the
/// picture; it shrinks to stay inside `visible` (the screen minus the menu
/// bar and Dock) and grows to respect `min`. It stays centred where it was,
/// moved only as far as needed to remain on screen. When `min` and `visible`
/// cannot both be met with the picture's shape, the window stays on screen
/// and the picture is letterboxed.
pub fn fitted_frame(current: Rect, visible: Rect, video: (f64, f64), min: (f64, f64)) -> Rect {
    let (video_width, video_height) = video;
    if video_width <= 0.0 || video_height <= 0.0 || visible.width <= 0.0 || visible.height <= 0.0 {
        return current;
    }
    let aspect = video_width / video_height;

    let mut width = current.width;
    let mut height = width / aspect;
    if height > visible.height {
        height = visible.height;
        width = height * aspect;
    }
    if width > visible.width {
        width = visible.width;
        height = width / aspect;
    }
    if width < min.0 {
        width = min.0;
        height = width / aspect;
    }
    if height < min.1 {
        height = min.1;
        width = height * aspect;
    }
    // The minimum won over the picture's shape; do not leave the screen for it.
    width = width.min(visible.width).round();
    height = height.min(visible.height).round();

    let (center_x, center_y) = current.center();
    let x = (center_x - width / 2.0)
        .min(visible.x + visible.width - width)
        .max(visible.x);
    let y = (center_y - height / 2.0)
        .min(visible.y + visible.height - height)
        .max(visible.y);
    Rect {
        x: x.round(),
        y: y.round(),
        width,
        height,
    }
}

/// The frame of a window that is given `extra` more width, on its right, for
/// a panel beside the picture.
///
/// The picture should not move: the window keeps its left edge and its
/// height. Where that would run off the screen it slides left, and where the
/// screen is simply not wide enough it takes the whole width, and the
/// picture gives up the difference.
pub fn widened_frame(current: Rect, visible: Rect, extra: f64) -> Rect {
    if extra <= 0.0 || visible.width <= 0.0 {
        return current;
    }
    let width = (current.width + extra).min(visible.width);
    let x = current
        .x
        .min(visible.x + visible.width - width)
        .max(visible.x);
    Rect {
        x: x.round(),
        width: width.round(),
        ..current
    }
}

/// The share of a window's width that a strip `reserved` wide takes, for
/// keeping the picture out of it. Never the whole window.
pub fn reserved_share(reserved: f64, window_width: f64) -> f64 {
    if reserved <= 0.0 || window_width <= 0.0 {
        return 0.0;
    }
    (reserved / window_width).min(0.9)
}

/// Where a scroll gesture is in its course.
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub enum ScrollPhase {
    /// Fingers have started to move.
    Began,
    /// They are moving; also every notch of a wheel, which has no phases.
    Moved,
    /// They have lifted.
    Ended,
}

/// How far the fingers moved, right and up, given what a scroll event says
/// and whether "natural" scrolling is on.
///
/// With natural scrolling the content follows the fingers, so a delta is the
/// fingers' own movement except that the vertical axis counts downward. With
/// it off, the content moves against the fingers and both axes are reversed.
/// A mouse wheel turned away from the user comes out as "up" either way.
pub fn finger_travel(delta_x: f64, delta_y: f64, natural: bool) -> (f64, f64) {
    if natural {
        (delta_x, -delta_y)
    } else {
        (-delta_x, delta_y)
    }
}

/// Whether a point on the screen is within the top-left corner of a window
/// where the traffic lights are: `lead` wide and `bar` tall. Screen
/// coordinates, with the origin at the bottom left as AppKit has it.
pub fn in_title_bar_lead(point: (f64, f64), window: Rect, lead: f64, bar: f64) -> bool {
    let across = point.0 - window.x;
    let down = window.y + window.height - point.1;
    (0.0..=lead).contains(&across) && (0.0..=bar).contains(&down)
}

/// The vertical inset to ask Tauri for so that the traffic lights are centred
/// `centre` points below the top of the window.
///
/// Tauri makes the title-bar strip `button_height + inset` tall. macOS keeps
/// each button where it laid it out, measured from the bottom of that strip:
/// its centre is `centre_above_bottom` points up. So the centre ends up
/// `button_height + inset - centre_above_bottom` below the top.
pub fn traffic_light_inset(centre: f64, button_height: f64, centre_above_bottom: f64) -> f64 {
    centre - button_height + centre_above_bottom
}

#[cfg(test)]
mod tests {
    use super::*;

    const SCREEN: Rect = Rect {
        x: 0.0,
        y: 80.0,
        width: 1728.0,
        height: 1000.0,
    };
    const MIN: (f64, f64) = (560.0, 360.0);

    fn window(width: f64, height: f64) -> Rect {
        Rect {
            x: 300.0,
            y: 300.0,
            width,
            height,
        }
    }

    #[test]
    fn keeps_the_width_and_matches_the_pictures_shape() {
        let frame = fitted_frame(window(1120.0, 680.0), SCREEN, (1920.0, 1080.0), MIN);
        assert_eq!((frame.width, frame.height), (1120.0, 630.0));
    }

    #[test]
    fn stays_centred_where_it_was() {
        let before = window(1120.0, 680.0);
        let frame = fitted_frame(before, SCREEN, (1920.0, 1080.0), MIN);
        assert_eq!(frame.x + frame.width / 2.0, before.x + before.width / 2.0);
        assert_eq!(frame.y + frame.height / 2.0, before.y + before.height / 2.0);
    }

    #[test]
    fn shrinks_a_tall_picture_to_the_screen_height() {
        let frame = fitted_frame(window(1120.0, 680.0), SCREEN, (1080.0, 1920.0), MIN);
        assert_eq!(frame.height, 1000.0);
        assert_eq!(frame.width, 563.0);
        assert!(frame.y >= SCREEN.y && frame.y + frame.height <= SCREEN.y + SCREEN.height);
    }

    #[test]
    fn grows_a_very_wide_picture_to_the_minimum_height() {
        // 32:9 at 560 wide would be 158 tall.
        let frame = fitted_frame(window(560.0, 360.0), SCREEN, (3840.0, 1080.0), MIN);
        assert_eq!(frame.height, 360.0);
        assert_eq!(frame.width, 1280.0);
    }

    #[test]
    fn never_leaves_the_screen_even_when_the_minimum_cannot_keep_the_shape() {
        let small = Rect {
            x: 0.0,
            y: 0.0,
            width: 800.0,
            height: 500.0,
        };
        // An extremely wide strip: at the minimum height it would be 3600 wide.
        let frame = fitted_frame(window(700.0, 400.0), small, (10_000.0, 1000.0), MIN);
        assert_eq!((frame.width, frame.height), (800.0, 360.0));
        assert_eq!(frame.x, 0.0);
    }

    #[test]
    fn moves_back_on_screen_if_the_new_size_would_hang_off_an_edge() {
        let near_edge = Rect {
            x: 1500.0,
            y: 900.0,
            width: 1120.0,
            height: 680.0,
        };
        let frame = fitted_frame(near_edge, SCREEN, (1920.0, 1080.0), MIN);
        assert_eq!(frame.x + frame.width, SCREEN.x + SCREEN.width);
        assert_eq!(frame.y + frame.height, SCREEN.y + SCREEN.height);
    }

    #[test]
    fn leaves_the_window_alone_for_a_picture_with_no_size() {
        let before = window(1120.0, 680.0);
        assert_eq!(fitted_frame(before, SCREEN, (0.0, 1080.0), MIN), before);
        assert_eq!(fitted_frame(before, SCREEN, (1920.0, 0.0), MIN), before);
    }

    #[test]
    fn a_window_already_the_right_shape_does_not_move() {
        let before = window(1120.0, 630.0);
        assert_eq!(fitted_frame(before, SCREEN, (3840.0, 2160.0), MIN), before);
    }

    #[test]
    fn a_window_grows_on_the_right_without_moving_the_picture() {
        let before = window(960.0, 540.0);
        let after = widened_frame(before, SCREEN, 348.0);
        assert_eq!((after.x, after.y), (before.x, before.y));
        assert_eq!((after.width, after.height), (1308.0, 540.0));
    }

    #[test]
    fn a_window_near_the_right_edge_slides_left_to_make_room() {
        let before = Rect {
            x: 600.0,
            y: 300.0,
            width: 1120.0,
            height: 630.0,
        };
        let after = widened_frame(before, SCREEN, 348.0);
        assert_eq!(after.width, 1468.0);
        assert_eq!(after.x + after.width, SCREEN.x + SCREEN.width);
    }

    #[test]
    fn on_a_screen_too_narrow_the_picture_gives_up_the_room() {
        let before = Rect {
            x: 100.0,
            y: 300.0,
            width: 1600.0,
            height: 900.0,
        };
        let after = widened_frame(before, SCREEN, 348.0);
        assert_eq!((after.x, after.width), (SCREEN.x, SCREEN.width));
        assert_eq!(after.height, 900.0);
    }

    #[test]
    fn works_out_the_share_of_the_window_a_panel_takes() {
        assert_eq!(reserved_share(348.0, 1392.0), 0.25);
        assert_eq!(reserved_share(0.0, 1392.0), 0.0);
        assert_eq!(reserved_share(348.0, 0.0), 0.0);
        // A panel can never be given the whole window.
        assert_eq!(reserved_share(2000.0, 1000.0), 0.9);
    }

    #[test]
    fn reads_the_fingers_direction_whichever_way_scrolling_is_set() {
        // Natural: fingers up moves the content up, reported as a negative delta.
        assert_eq!(finger_travel(0.0, -12.0, true), (0.0, 12.0));
        assert_eq!(finger_travel(8.0, 0.0, true), (8.0, 0.0));
        // Classic: a wheel turned away from the user reports a positive delta.
        assert_eq!(finger_travel(0.0, 3.0, false), (0.0, 3.0));
        assert_eq!(finger_travel(-8.0, 0.0, false), (8.0, 0.0));
    }

    #[test]
    fn insets_the_traffic_lights_for_the_button_size_in_use() {
        // macOS 26 and later: 14 pt buttons whose centres are 16 pt above the
        // bottom of a 32 pt title bar. Measured on macOS 27.
        assert_eq!(traffic_light_inset(22.0, 14.0, 16.0), 24.0);
        // Earlier versions: 16 pt buttons centred in a 28 pt title bar.
        assert_eq!(traffic_light_inset(22.0, 16.0, 14.0), 20.0);
    }

    #[test]
    fn the_inset_puts_the_centre_where_it_was_asked_for() {
        for (height, above) in [(14.0, 16.0), (16.0, 14.0), (20.0, 19.0)] {
            let inset = traffic_light_inset(22.0, height, above);
            // The strip is `height + inset` tall; the centre is `above` from its bottom.
            assert_eq!(height + inset - above, 22.0);
        }
    }

    #[test]
    fn finds_the_pointer_on_the_traffic_lights() {
        // A 1000 x 600 window whose bottom-left corner is at (100, 200):
        // its top edge is at y = 800.
        let window = Rect {
            x: 100.0,
            y: 200.0,
            width: 1000.0,
            height: 600.0,
        };
        let on = |x: f64, y: f64| in_title_bar_lead((x, y), window, 88.0, 44.0);
        assert!(on(120.0, 780.0), "on the close button");
        assert!(on(188.0, 756.0), "at the corner of the zone");
        assert!(!on(189.0, 780.0), "to the right of the lights");
        assert!(!on(120.0, 755.0), "below the title bar");
        assert!(!on(99.0, 780.0), "left of the window");
        assert!(!on(120.0, 801.0), "above the window");
    }
}
