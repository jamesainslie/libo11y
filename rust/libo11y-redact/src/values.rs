//! [`Redact`] for the standard library's types.
//!
//! Scalars and strings render as themselves and mask under a mask floor.
//! Opaque values with a text form, such as addresses and durations, render
//! as that text. Collections and smart pointers pass the floor to every
//! element, enforce it on what each element returns, and count toward the
//! depth bound, so a value nested too deep renders as `REDACTED`.

use std::borrow::Cow;
use std::collections::{BTreeMap, BTreeSet, HashMap, HashSet, VecDeque};
use std::marker::PhantomData;
use std::net::{IpAddr, Ipv4Addr, Ipv6Addr, SocketAddr, SocketAddrV4, SocketAddrV6};
use std::path::{Path, PathBuf};
use std::rc::Rc;
use std::sync::Arc;
use std::time::Duration;

use crate::private::enter;
use crate::{Protected, Protection, Redact};

/// Renders `value` under `floor` and enforces the floor on the result, so
/// an implementation that ignores its floor still cannot weaken it.
pub(crate) fn child<T: Redact + ?Sized>(value: &T, floor: Protection) -> Protected {
    value.redact(floor).at_floor(floor)
}

/// Renders a sequence one level deeper.
fn seq<'a, T: Redact + 'a>(items: impl IntoIterator<Item = &'a T>, floor: Protection) -> Protected {
    if floor.hides_value() {
        return Protected::Redacted;
    }
    let Some(_depth) = enter() else {
        return Protected::Redacted;
    };
    Protected::Seq(items.into_iter().map(|item| child(item, floor)).collect())
}

/// Renders an unordered sequence one level deeper, sorted by each item's
/// protected text so the output is deterministic.
fn sorted_seq<'a, T: Redact + 'a>(
    items: impl IntoIterator<Item = &'a T>,
    floor: Protection,
) -> Protected {
    match seq(items, floor) {
        Protected::Seq(mut items) => {
            items.sort_by_cached_key(ToString::to_string);
            Protected::Seq(items)
        }
        other => other,
    }
}

/// Renders map entries one level deeper, optionally sorted by key text and
/// then by value text, so an unordered map renders deterministically.
fn map<'a, K: Redact + 'a, V: Redact + 'a>(
    entries: impl IntoIterator<Item = (&'a K, &'a V)>,
    floor: Protection,
    sort: bool,
) -> Protected {
    if floor.hides_value() {
        return Protected::Redacted;
    }
    let Some(_depth) = enter() else {
        return Protected::Redacted;
    };
    let mut entries: Vec<(Protected, Protected)> = entries
        .into_iter()
        .map(|(key, value)| (child(key, floor), child(value, floor)))
        .collect();
    if sort {
        entries.sort_by_cached_key(|(key, value)| (key.to_string(), value.to_string()));
    }
    Protected::Map(entries)
}

/// Renders the value behind a pointer one level deeper.
fn pointee<T: Redact + ?Sized>(value: &T, floor: Protection) -> Protected {
    if floor.hides_value() {
        return Protected::Redacted;
    }
    let Some(_depth) = enter() else {
        return Protected::Redacted;
    };
    child(value, floor)
}

macro_rules! leaf {
    ($($ty:ty => |$v:ident| $render:expr;)*) => {$(
        impl Redact for $ty {
            fn redact(&self, floor: Protection) -> Protected {
                if floor.hides_value() {
                    return Protected::Redacted;
                }
                let $v = self;
                Protected::at_floor($render, floor)
            }
        }
    )*};
}

leaf! {
    bool => |v| Protected::Bool(*v);
    i8 => |v| Protected::Int(i128::from(*v));
    i16 => |v| Protected::Int(i128::from(*v));
    i32 => |v| Protected::Int(i128::from(*v));
    i64 => |v| Protected::Int(i128::from(*v));
    i128 => |v| Protected::Int(*v);
    // isize is at most 64 bits on every supported target.
    isize => |v| i64::try_from(*v).map_or(Protected::Redacted, |n| Protected::Int(i128::from(n)));
    u8 => |v| Protected::Uint(u128::from(*v));
    u16 => |v| Protected::Uint(u128::from(*v));
    u32 => |v| Protected::Uint(u128::from(*v));
    u64 => |v| Protected::Uint(u128::from(*v));
    u128 => |v| Protected::Uint(*v);
    usize => |v| u64::try_from(*v).map_or(Protected::Redacted, |n| Protected::Uint(u128::from(n)));
    // Through its own shortest text, so 0.1_f32 stays 0.1 rather than
    // widening to 0.10000000149011612.
    f32 => |v| v.to_string().parse().map_or(Protected::Redacted, Protected::Float);
    f64 => |v| Protected::Float(*v);
    char => |v| Protected::Str(v.to_string());
    str => |v| Protected::Str(v.to_owned());
    String => |v| Protected::Str(v.clone());
    Path => |v| Protected::Str(v.display().to_string());
    PathBuf => |v| Protected::Str(v.display().to_string());
    IpAddr => |v| Protected::Text(v.to_string());
    Ipv4Addr => |v| Protected::Text(v.to_string());
    Ipv6Addr => |v| Protected::Text(v.to_string());
    SocketAddr => |v| Protected::Text(v.to_string());
    SocketAddrV4 => |v| Protected::Text(v.to_string());
    SocketAddrV6 => |v| Protected::Text(v.to_string());
    Duration => |v| Protected::Text(format!("{v:?}"));
}

impl Redact for () {
    fn redact(&self, floor: Protection) -> Protected {
        Protected::Null.at_floor(floor)
    }
}

impl<T: ?Sized> Redact for PhantomData<T> {
    fn redact(&self, floor: Protection) -> Protected {
        Protected::Null.at_floor(floor)
    }
}

impl<T: Redact> Redact for Option<T> {
    fn redact(&self, floor: Protection) -> Protected {
        match self {
            _ if floor.hides_value() => Protected::Redacted,
            None => Protected::Null,
            Some(value) => child(value, floor),
        }
    }
}

impl<T: Redact + ?Sized> Redact for &T {
    fn redact(&self, floor: Protection) -> Protected {
        child(&**self, floor)
    }
}

impl<T: Redact + ?Sized> Redact for &mut T {
    fn redact(&self, floor: Protection) -> Protected {
        child(&**self, floor)
    }
}

impl<T: Redact + ToOwned + ?Sized> Redact for Cow<'_, T> {
    fn redact(&self, floor: Protection) -> Protected {
        child(&**self, floor)
    }
}

impl<T: Redact + ?Sized> Redact for Box<T> {
    fn redact(&self, floor: Protection) -> Protected {
        pointee(&**self, floor)
    }
}

impl<T: Redact + ?Sized> Redact for Rc<T> {
    fn redact(&self, floor: Protection) -> Protected {
        pointee(&**self, floor)
    }
}

impl<T: Redact + ?Sized> Redact for Arc<T> {
    fn redact(&self, floor: Protection) -> Protected {
        pointee(&**self, floor)
    }
}

impl<T: Redact> Redact for [T] {
    fn redact(&self, floor: Protection) -> Protected {
        seq(self, floor)
    }
}

impl<T: Redact, const N: usize> Redact for [T; N] {
    fn redact(&self, floor: Protection) -> Protected {
        seq(self, floor)
    }
}

impl<T: Redact> Redact for Vec<T> {
    fn redact(&self, floor: Protection) -> Protected {
        seq(self, floor)
    }
}

impl<T: Redact> Redact for VecDeque<T> {
    fn redact(&self, floor: Protection) -> Protected {
        seq(self, floor)
    }
}

impl<T: Redact> Redact for BTreeSet<T> {
    fn redact(&self, floor: Protection) -> Protected {
        seq(self, floor)
    }
}

impl<T: Redact, S> Redact for HashSet<T, S> {
    fn redact(&self, floor: Protection) -> Protected {
        sorted_seq(self, floor)
    }
}

impl<K: Redact, V: Redact> Redact for BTreeMap<K, V> {
    fn redact(&self, floor: Protection) -> Protected {
        map(self, floor, false)
    }
}

impl<K: Redact, V: Redact, S> Redact for HashMap<K, V, S> {
    fn redact(&self, floor: Protection) -> Protected {
        map(self, floor, true)
    }
}

macro_rules! tuple {
    ($($name:ident: $index:tt),+) => {
        impl<$($name: Redact),+> Redact for ($($name,)+) {
            fn redact(&self, floor: Protection) -> Protected {
                if floor.hides_value() {
                    return Protected::Redacted;
                }
                let Some(_depth) = enter() else {
                    return Protected::Redacted;
                };
                Protected::Seq(vec![$(child(&self.$index, floor)),+])
            }
        }
    };
}

tuple!(A: 0);
tuple!(A: 0, B: 1);
tuple!(A: 0, B: 1, C: 2);
tuple!(A: 0, B: 1, C: 2, D: 3);
tuple!(A: 0, B: 1, C: 2, D: 3, E: 4);
tuple!(A: 0, B: 1, C: 2, D: 3, E: 4, F: 5);
