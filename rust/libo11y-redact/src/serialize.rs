//! `serde::Serialize` for the protected tree and the wrappers.

use std::collections::HashSet;

use serde::ser::{
    Serialize, SerializeMap, SerializeStruct, SerializeStructVariant, SerializeTupleStruct,
    SerializeTupleVariant, Serializer,
};

use crate::{Fields, Masked, Protected, Protection, REDACTED, Record, Redact, Secret};

impl Serialize for Protected {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        match self {
            Self::Null => serializer.serialize_none(),
            Self::Bool(b) => serializer.serialize_bool(*b),
            // The narrow forms first, so serializers without 128-bit support
            // still take every value that fits 64 bits.
            Self::Int(n) => match i64::try_from(*n) {
                Ok(n) => serializer.serialize_i64(n),
                Err(_) => serializer.serialize_i128(*n),
            },
            Self::Uint(n) => match u64::try_from(*n) {
                Ok(n) => serializer.serialize_u64(n),
                Err(_) => serializer.serialize_u128(*n),
            },
            Self::Float(x) if x.is_finite() => serializer.serialize_f64(*x),
            // Go's spelling of the values JSON cannot hold.
            Self::Float(x) if x.is_nan() => serializer.serialize_str("NaN"),
            Self::Float(x) if x.is_sign_positive() => serializer.serialize_str("+Inf"),
            Self::Float(_) => serializer.serialize_str("-Inf"),
            Self::Str(s) | Self::Text(s) => serializer.serialize_str(s),
            Self::Redacted => serializer.serialize_str(REDACTED),
            Self::Seq(items) => serializer.collect_seq(items),
            Self::Map(entries) => serialize_map(entries, serializer),
            Self::Record(record) => record.serialize(serializer),
        }
    }
}

/// Serializes map entries keyed by each key's protected text. Keys whose
/// text collides, such as two keys that both render `REDACTED`, would
/// overwrite each other in a map, so the entries then render by position,
/// each as `{"key": text, "value": value}`, as Go's `redact.Struct` does.
fn serialize_map<S: Serializer>(
    entries: &[(Protected, Protected)],
    serializer: S,
) -> Result<S::Ok, S::Error> {
    let keys: Vec<String> = entries.iter().map(|(key, _)| key.to_string()).collect();
    let mut seen = HashSet::with_capacity(keys.len());
    let positional = !keys.iter().all(|key| seen.insert(key.as_str()));
    let mut map = serializer.serialize_map(Some(entries.len()))?;
    for (pos, (key, (_, value))) in keys.iter().zip(entries).enumerate() {
        if positional {
            map.serialize_entry(&pos.to_string(), &PositionalEntry { key, value })?;
        } else {
            map.serialize_entry(key, value)?;
        }
    }
    map.end()
}

struct PositionalEntry<'a> {
    key: &'a str,
    value: &'a Protected,
}

impl Serialize for PositionalEntry<'_> {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        let mut entry = serializer.serialize_struct("Entry", 2)?;
        entry.serialize_field("key", self.key)?;
        entry.serialize_field("value", self.value)?;
        entry.end()
    }
}

impl Serialize for Record {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        match (self.variant, &self.fields) {
            (None, Fields::Named(fields)) => {
                let mut s = serializer.serialize_struct(self.name, fields.len())?;
                for (name, value) in fields {
                    s.serialize_field(name, value)?;
                }
                s.end()
            }
            (None, Fields::Unnamed(fields)) if fields.len() == 1 => {
                serializer.serialize_newtype_struct(self.name, &fields[0])
            }
            (None, Fields::Unnamed(fields)) => {
                let mut t = serializer.serialize_tuple_struct(self.name, fields.len())?;
                for value in fields {
                    t.serialize_field(value)?;
                }
                t.end()
            }
            (None, Fields::Unit) => serializer.serialize_unit_struct(self.name),
            (Some(v), Fields::Named(fields)) => {
                let mut s = serializer.serialize_struct_variant(
                    self.name,
                    v.index,
                    v.name,
                    fields.len(),
                )?;
                for (name, value) in fields {
                    s.serialize_field(name, value)?;
                }
                s.end()
            }
            (Some(v), Fields::Unnamed(fields)) if fields.len() == 1 => {
                serializer.serialize_newtype_variant(self.name, v.index, v.name, &fields[0])
            }
            (Some(v), Fields::Unnamed(fields)) => {
                let mut t =
                    serializer.serialize_tuple_variant(self.name, v.index, v.name, fields.len())?;
                for value in fields {
                    t.serialize_field(value)?;
                }
                t.end()
            }
            (Some(v), Fields::Unit) => {
                serializer.serialize_unit_variant(self.name, v.index, v.name)
            }
        }
    }
}

impl<T> Serialize for Secret<T> {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        serializer.serialize_str(REDACTED)
    }
}

impl<T: std::fmt::Display> Serialize for Masked<T> {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        self.redact(Protection::Passthrough).serialize(serializer)
    }
}
