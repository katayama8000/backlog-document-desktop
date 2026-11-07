use std::fmt;

use crate::Error;

const ALLOWED_SUFFIXES: [&str; 3] = [".backlog.jp", ".backlog.com", ".backlogtool.com"];

/// A normalized Backlog space URL such as `https://example.backlog.jp`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SpaceUrl(String);

impl SpaceUrl {
    /// Accepts input with or without a scheme, trailing slash or path,
    /// and normalizes it to `https://{host}`.
    pub fn parse(input: &str) -> Result<Self, Error> {
        let trimmed = input.trim();
        let with_scheme = if trimmed.contains("://") {
            trimmed.to_string()
        } else {
            format!("https://{trimmed}")
        };
        let invalid = || Error::InvalidSpaceUrl(input.to_string());
        let url = url::Url::parse(&with_scheme).map_err(|_| invalid())?;
        if url.scheme() != "https" {
            return Err(invalid());
        }
        let host = url.host_str().ok_or_else(invalid)?.to_ascii_lowercase();
        let is_backlog = ALLOWED_SUFFIXES
            .iter()
            .any(|suffix| host.len() > suffix.len() && host.ends_with(suffix));
        if !is_backlog {
            return Err(invalid());
        }
        Ok(Self(format!("https://{host}")))
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }
}

impl fmt::Display for SpaceUrl {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.0)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalizes_various_inputs() {
        for input in [
            "example.backlog.jp",
            "https://example.backlog.jp",
            "https://example.backlog.jp/",
            "https://EXAMPLE.backlog.jp/dashboard",
            "  https://example.backlog.jp/document/PROJ/abc  ",
        ] {
            assert_eq!(
                SpaceUrl::parse(input).unwrap().as_str(),
                "https://example.backlog.jp",
                "input: {input}"
            );
        }
        assert_eq!(
            SpaceUrl::parse("foo.backlogtool.com").unwrap().as_str(),
            "https://foo.backlogtool.com"
        );
    }

    #[test]
    fn rejects_non_backlog_or_insecure_urls() {
        for input in [
            "",
            "http://example.backlog.jp",
            "https://example.com",
            "https://backlog.jp",
            "https://evil.com/.backlog.jp",
        ] {
            assert!(SpaceUrl::parse(input).is_err(), "input: {input}");
        }
    }
}
