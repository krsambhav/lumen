//! The menu bar.
//!
//! What is in it is decided by the interface, which owns the registry of
//! actions: it sends a description (names, shortcuts, what is ticked, what
//! cannot be done now), this module makes the menus from it, and the
//! interface is told when an item is chosen. The menus every Mac app has
//! (the app's own, Edit, Window, Help) are added here; what the interface
//! has for the app's own menu (Check for Updates) is put in it, under About.
//!
//! The shortcuts are real key equivalents, so they look and read as they
//! should. They do not make the menu bar a second judge of what a key means:
//! the web view offers every key to the page first, and the page's rules
//! (see `useGlobalShortcuts`) settle it there.

use std::collections::HashMap;

use parking_lot::Mutex;
use serde::Deserialize;
use specta::Type;
use tauri::menu::{CheckMenuItem, IsMenuItem, Menu, MenuItem, PredefinedMenuItem, Submenu};
use tauri::{AppHandle, Wry};

use crate::error::AppResult;

/// What the ids of items that run an action start with.
pub const ACTION_PREFIX: &str = "action:";

/// One menu of the bar, as the interface describes it.
#[derive(Debug, Clone, PartialEq, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct MenuSection {
    pub name: String,
    pub items: Vec<MenuEntry>,
}

#[derive(Debug, Clone, PartialEq, Deserialize, Type)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum MenuEntry {
    /// An item that runs a registered action.
    Action {
        /// The action's id.
        id: String,
        name: String,
        /// Chord text as the interface writes it: "Shift+Cmd+p", "Space".
        shortcut: Option<String>,
        enabled: bool,
        /// For an action that switches something on and off: whether it is on.
        checked: Option<bool>,
    },
    /// A menu within the menu: one of several to choose from, or a list.
    Submenu {
        name: String,
        items: Vec<MenuEntry>,
    },
    Separator,
}

/// The parts of an action item that can change without the menus being rebuilt.
#[derive(Debug, Clone, PartialEq)]
struct Shown {
    name: String,
    shortcut: Option<String>,
    enabled: bool,
    checked: Option<bool>,
}

enum Item {
    Plain(MenuItem<Wry>),
    Check(CheckMenuItem<Wry>),
}

impl Item {
    fn update(&self, from: &Shown, to: &Shown) -> tauri::Result<()> {
        macro_rules! apply {
            ($item:expr) => {{
                if from.name != to.name {
                    $item.set_text(&to.name)?;
                }
                if from.enabled != to.enabled {
                    $item.set_enabled(to.enabled)?;
                }
                if from.shortcut != to.shortcut {
                    $item.set_accelerator(to.shortcut.as_deref())?;
                }
            }};
        }
        match self {
            Self::Plain(item) => apply!(item),
            Self::Check(item) => {
                apply!(item);
                if from.checked != to.checked {
                    item.set_checked(to.checked.unwrap_or(false))?;
                }
            }
        }
        Ok(())
    }
}

/// The menu bar as it was last made.
#[derive(Default)]
pub struct MenuBar {
    made: Mutex<Made>,
}

#[derive(Default)]
struct Made {
    /// Which items are where; when this changes the menus are made again.
    shape: Option<String>,
    items: HashMap<String, (Item, Shown)>,
}

/// What decides whether the menus must be made again rather than touched up:
/// which items there are, in what order, and which of them can be ticked.
fn shape_of(own: &[MenuEntry], sections: &[MenuSection]) -> String {
    fn list(entries: &[MenuEntry], shape: &mut String) {
        shape.push('[');
        for entry in entries {
            match entry {
                MenuEntry::Action { id, checked, .. } => {
                    shape.push_str(id);
                    if checked.is_some() {
                        shape.push('?');
                    }
                }
                MenuEntry::Submenu { name, items } => {
                    shape.push_str(name);
                    list(items, shape);
                }
                MenuEntry::Separator => shape.push('-'),
            }
            shape.push('|');
        }
        shape.push(']');
    }
    let mut shape = String::new();
    // The app's own menu has no name to tell it by: it comes first.
    list(own, &mut shape);
    for section in sections {
        shape.push_str(&section.name);
        list(&section.items, &mut shape);
    }
    shape
}

/// Every item that runs something, wherever in the menus it is.
fn actions(entries: &[MenuEntry]) -> Vec<&MenuEntry> {
    let mut found = Vec::new();
    for entry in entries {
        match entry {
            MenuEntry::Action { .. } => found.push(entry),
            MenuEntry::Submenu { items, .. } => found.extend(actions(items)),
            MenuEntry::Separator => {}
        }
    }
    found
}

impl MenuBar {
    /// Makes the menu bar say what `sections` describes, with `own` in the
    /// app's own menu. Only what has changed is touched, so a menu that is
    /// open stays as it is.
    pub fn apply(
        &self,
        app: &AppHandle,
        own: &[MenuEntry],
        sections: &[MenuSection],
    ) -> AppResult<()> {
        let mut made = self.made.lock();
        let shape = shape_of(own, sections);
        if made.shape.as_deref() != Some(shape.as_str()) {
            let (menu, items) = build(app, own, sections)?;
            app.set_menu(menu)?;
            made.shape = Some(shape);
            made.items = items;
            return Ok(());
        }
        let everywhere = actions(own)
            .into_iter()
            .chain(sections.iter().flat_map(|section| actions(&section.items)));
        for entry in everywhere {
            let MenuEntry::Action {
                id,
                name,
                shortcut,
                enabled,
                checked,
            } = entry
            else {
                continue;
            };
            let now = Shown {
                name: name.clone(),
                shortcut: shortcut.clone(),
                enabled: *enabled,
                checked: *checked,
            };
            if let Some((item, shown)) = made.items.get_mut(id) {
                if *shown != now {
                    item.update(shown, &now)?;
                    *shown = now;
                }
            }
        }
        Ok(())
    }
}

type Items = HashMap<String, (Item, Shown)>;

fn build(
    app: &AppHandle,
    own: &[MenuEntry],
    sections: &[MenuSection],
) -> AppResult<(Menu<Wry>, Items)> {
    let mut items = Items::new();
    let menu = Menu::new(app)?;
    menu.append(&app_menu(app, own, &mut items)?)?;

    for (index, section) in sections.iter().enumerate() {
        let submenu = Submenu::new(app, &section.name, true)?;
        fill(app, &submenu, &section.items, &mut items)?;
        menu.append(&submenu)?;
        // Edit comes second, after File, as it does in every Mac app.
        if index == 0 {
            menu.append(&edit_menu(app)?)?;
        }
    }
    if sections.is_empty() {
        menu.append(&edit_menu(app)?)?;
    }

    let window = Submenu::with_items(
        app,
        "Window",
        true,
        &[
            &PredefinedMenuItem::minimize(app, None)?,
            &PredefinedMenuItem::maximize(app, Some("Zoom"))?,
        ],
    )?;
    menu.append(&window)?;
    window.set_as_windows_menu_for_nsapp()?;

    // Empty on purpose: macOS puts its search of the menus in it.
    let help = Submenu::new(app, "Help", true)?;
    menu.append(&help)?;
    help.set_as_help_menu_for_nsapp()?;

    Ok((menu, items))
}

/// Puts `entries` into `menu`, and notes each item that runs something.
fn fill(
    app: &AppHandle,
    menu: &Submenu<Wry>,
    entries: &[MenuEntry],
    items: &mut Items,
) -> AppResult<()> {
    for entry in entries {
        match entry {
            MenuEntry::Separator => menu.append(&PredefinedMenuItem::separator(app)?)?,
            MenuEntry::Submenu { name, items: inner } => {
                let submenu = Submenu::new(app, name, true)?;
                fill(app, &submenu, inner, items)?;
                menu.append(&submenu)?;
            }
            MenuEntry::Action {
                id,
                name,
                shortcut,
                enabled,
                checked,
            } => {
                let item_id = format!("{ACTION_PREFIX}{id}");
                let item = match checked {
                    Some(checked) => Item::Check(check_item(
                        app, &item_id, name, *enabled, *checked, shortcut,
                    )?),
                    None => Item::Plain(plain_item(app, &item_id, name, *enabled, shortcut)?),
                };
                match &item {
                    Item::Plain(item) => menu.append(item)?,
                    Item::Check(item) => menu.append(item)?,
                }
                let shown = Shown {
                    name: name.clone(),
                    shortcut: shortcut.clone(),
                    enabled: *enabled,
                    checked: *checked,
                };
                items.insert(id.clone(), (item, shown));
            }
        }
    }
    Ok(())
}

/// An item with its shortcut, or without it if macOS has no such key
/// equivalent: the shortcut still works, it is only not shown.
fn plain_item(
    app: &AppHandle,
    id: &str,
    name: &str,
    enabled: bool,
    shortcut: &Option<String>,
) -> tauri::Result<MenuItem<Wry>> {
    MenuItem::with_id(app, id, name, enabled, shortcut.as_deref()).or_else(|error| {
        tracing::warn!(%error, ?shortcut, "a menu item has no key equivalent");
        MenuItem::with_id(app, id, name, enabled, None::<&str>)
    })
}

fn check_item(
    app: &AppHandle,
    id: &str,
    name: &str,
    enabled: bool,
    checked: bool,
    shortcut: &Option<String>,
) -> tauri::Result<CheckMenuItem<Wry>> {
    CheckMenuItem::with_id(app, id, name, enabled, checked, shortcut.as_deref()).or_else(|error| {
        tracing::warn!(%error, ?shortcut, "a menu item has no key equivalent");
        CheckMenuItem::with_id(app, id, name, enabled, checked, None::<&str>)
    })
}

/// The app's own menu: the items every Mac app has there, with what the
/// interface adds (`own`) straight under About, where a Mac app keeps Check
/// for Updates.
fn app_menu(app: &AppHandle, own: &[MenuEntry], items: &mut Items) -> AppResult<Submenu<Wry>> {
    let menu = Submenu::new(app, "Lumen", true)?;
    menu.append(&PredefinedMenuItem::about(app, Some("About Lumen"), None)?)?;
    fill(app, &menu, own, items)?;
    let rest: Vec<Box<dyn IsMenuItem<Wry>>> = vec![
        Box::new(PredefinedMenuItem::separator(app)?),
        Box::new(PredefinedMenuItem::services(app, None)?),
        Box::new(PredefinedMenuItem::separator(app)?),
        Box::new(PredefinedMenuItem::hide(app, Some("Hide Lumen"))?),
        Box::new(PredefinedMenuItem::hide_others(app, None)?),
        Box::new(PredefinedMenuItem::show_all(app, None)?),
        Box::new(PredefinedMenuItem::separator(app)?),
        Box::new(PredefinedMenuItem::quit(app, Some("Quit Lumen"))?),
    ];
    for item in &rest {
        menu.append(item.as_ref())?;
    }
    Ok(menu)
}

/// The Edit menu, whose items are the system's own: they are what makes
/// copy and paste work in the interface's text fields.
fn edit_menu(app: &AppHandle) -> tauri::Result<Submenu<Wry>> {
    Submenu::with_items(
        app,
        "Edit",
        true,
        &[
            &PredefinedMenuItem::undo(app, None)?,
            &PredefinedMenuItem::redo(app, None)?,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::cut(app, None)?,
            &PredefinedMenuItem::copy(app, None)?,
            &PredefinedMenuItem::paste(app, None)?,
            &PredefinedMenuItem::select_all(app, None)?,
        ],
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    fn action(id: &str, checked: Option<bool>, enabled: bool) -> MenuEntry {
        MenuEntry::Action {
            id: id.to_owned(),
            name: id.to_owned(),
            shortcut: None,
            enabled,
            checked,
        }
    }

    fn section(items: Vec<MenuEntry>) -> Vec<MenuSection> {
        vec![MenuSection {
            name: "Playback".to_owned(),
            items,
        }]
    }

    #[test]
    fn the_shape_is_which_items_there_are_and_not_how_they_stand() {
        let before = section(vec![
            action("playback.toggle", None, true),
            MenuEntry::Separator,
            action("playlist.shuffle", Some(false), true),
        ]);
        // Ticked, and no longer available: the same menus, touched up.
        let after = section(vec![
            action("playback.toggle", None, false),
            MenuEntry::Separator,
            action("playlist.shuffle", Some(true), true),
        ]);
        assert_eq!(shape_of(&[], &before), shape_of(&[], &after));
    }

    #[test]
    fn what_is_in_the_app_s_own_menu_is_part_of_the_shape() {
        let sections = section(vec![action("playback.toggle", None, true)]);
        let own = |checked: bool| {
            vec![
                action("app.checkForUpdates", None, true),
                action("app.automaticUpdates", Some(checked), true),
            ]
        };
        // A tick that changes is touched up; an item that comes or goes is not.
        assert_eq!(
            shape_of(&own(true), &sections),
            shape_of(&own(false), &sections)
        );
        assert_ne!(shape_of(&own(true), &sections), shape_of(&[], &sections));
        // The same item in a menu of the bar is not the same menu bar.
        let moved = section(vec![
            action("playback.toggle", None, true),
            action("app.checkForUpdates", None, true),
        ]);
        assert_ne!(
            shape_of(&[action("app.checkForUpdates", None, true)], &sections),
            shape_of(&[], &moved)
        );
    }

    #[test]
    fn a_new_item_or_order_or_kind_is_a_new_shape() {
        let base = section(vec![action("a", None, true), action("b", None, true)]);
        let reordered = section(vec![action("b", None, true), action("a", None, true)]);
        let longer = section(vec![
            action("a", None, true),
            action("b", None, true),
            MenuEntry::Separator,
        ]);
        // An item that can now be ticked is a different kind of item.
        let tickable = section(vec![
            action("a", Some(false), true),
            action("b", None, true),
        ]);
        for other in [&reordered, &longer, &tickable] {
            assert_ne!(shape_of(&[], &base), shape_of(&[], other));
        }
    }

    #[test]
    fn a_submenu_is_part_of_the_shape_and_its_items_are_found() {
        let choice = |open: bool| {
            section(vec![
                action("playback.toggle", None, true),
                MenuEntry::Submenu {
                    name: "Repeat".to_owned(),
                    items: vec![
                        action("repeat:off", Some(!open), true),
                        action("repeat:all", Some(open), true),
                    ],
                },
            ])
        };
        // Which of them is ticked is touched up, not rebuilt.
        assert_eq!(shape_of(&[], &choice(false)), shape_of(&[], &choice(true)));
        let flat = section(vec![
            action("playback.toggle", None, true),
            action("repeat:off", Some(true), true),
            action("repeat:all", Some(false), true),
        ]);
        assert_ne!(shape_of(&[], &choice(false)), shape_of(&[], &flat));
        // Items inside a submenu are kept up to date like any other.
        let sections = choice(true);
        let ids: Vec<&str> = actions(&sections[0].items)
            .into_iter()
            .filter_map(|entry| match entry {
                MenuEntry::Action { id, .. } => Some(id.as_str()),
                _ => None,
            })
            .collect();
        assert_eq!(ids, ["playback.toggle", "repeat:off", "repeat:all"]);
    }

    #[test]
    fn reads_what_the_interface_sends() {
        let sections: Vec<MenuSection> = serde_json::from_str(
            r#"[{"name":"File","items":[
                {"kind":"action","id":"file.open","name":"Open File…","shortcut":"Cmd+o","enabled":true,"checked":null},
                {"kind":"separator"},
                {"kind":"submenu","name":"Open Recent","items":[
                    {"kind":"action","id":"recent:0","name":"A Quiet Hour (1962).mp4","shortcut":null,"enabled":true,"checked":null}
                ]}
            ]}]"#,
        )
        .unwrap();
        assert_eq!(sections[0].items.len(), 3);
        assert_eq!(sections[0].items[1], MenuEntry::Separator);
        let MenuEntry::Submenu { name, items } = &sections[0].items[2] else {
            panic!("the third entry is a submenu");
        };
        assert_eq!(name, "Open Recent");
        assert_eq!(items.len(), 1);
    }
}
