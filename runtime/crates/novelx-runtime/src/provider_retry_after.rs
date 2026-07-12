use std::time::{Duration, SystemTime};

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use thiserror::Error;

const MAX_RETRY_AFTER_BYTES: usize = 512;

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ProviderRetryAfterKind {
    DeltaSeconds,
    HttpDate,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ProviderRetryAfterReceipt {
    pub value_sha256: String,
    pub kind: ProviderRetryAfterKind,
    pub delay_ms: u64,
}

pub fn parse_provider_retry_after(
    value: &[u8],
    observed_at: SystemTime,
) -> Result<ProviderRetryAfterReceipt, ProviderRetryAfterError> {
    if value.is_empty() || value.len() > MAX_RETRY_AFTER_BYTES {
        return Err(ProviderRetryAfterError::Invalid);
    }
    let text = std::str::from_utf8(value).map_err(|_| ProviderRetryAfterError::Invalid)?;
    let trimmed = text.trim();
    if trimmed.is_empty() || trimmed.len() != text.len() {
        return Err(ProviderRetryAfterError::Invalid);
    }
    let value_sha256 = format!("{:x}", Sha256::digest(value));
    if trimmed.bytes().all(|byte| byte.is_ascii_digit()) {
        let seconds = trimmed
            .parse::<u64>()
            .map_err(|_| ProviderRetryAfterError::Invalid)?;
        let delay_ms = seconds
            .checked_mul(1_000)
            .ok_or(ProviderRetryAfterError::DelayOverflow)?;
        return Ok(ProviderRetryAfterReceipt {
            value_sha256,
            kind: ProviderRetryAfterKind::DeltaSeconds,
            delay_ms,
        });
    }
    let retry_at =
        httpdate::parse_http_date(trimmed).map_err(|_| ProviderRetryAfterError::Invalid)?;
    let delay = retry_at
        .duration_since(observed_at)
        .unwrap_or(Duration::ZERO);
    let delay_ms =
        u64::try_from(delay.as_millis()).map_err(|_| ProviderRetryAfterError::DelayOverflow)?;
    Ok(ProviderRetryAfterReceipt {
        value_sha256,
        kind: ProviderRetryAfterKind::HttpDate,
        delay_ms,
    })
}

#[derive(Clone, Copy, Debug, Eq, Error, PartialEq)]
pub enum ProviderRetryAfterError {
    #[error("Provider Retry-After header is invalid")]
    Invalid,
    #[error("Provider Retry-After delay does not fit the Runtime clock")]
    DelayOverflow,
}

#[cfg(test)]
mod tests {
    use std::time::{Duration, UNIX_EPOCH};

    use super::{ProviderRetryAfterError, ProviderRetryAfterKind, parse_provider_retry_after};

    #[test]
    fn parses_delta_seconds_without_retaining_the_raw_header() {
        let receipt = parse_provider_retry_after(b"120", UNIX_EPOCH).unwrap();
        assert_eq!(receipt.kind, ProviderRetryAfterKind::DeltaSeconds);
        assert_eq!(receipt.delay_ms, 120_000);
        assert_eq!(
            receipt.value_sha256,
            "2abaca4911e68fa9bfbf3482ee797fd5b9045b841fdff7253557c5fe15de6477"
        );
    }

    #[test]
    fn parses_all_http_date_wire_formats_and_clamps_past_dates_to_zero() {
        let observed = httpdate::parse_http_date("Sun, 06 Nov 1994 08:49:30 GMT").unwrap();
        for value in [
            "Sun, 06 Nov 1994 08:49:37 GMT",
            "Sunday, 06-Nov-94 08:49:37 GMT",
            "Sun Nov  6 08:49:37 1994",
        ] {
            let receipt = parse_provider_retry_after(value.as_bytes(), observed).unwrap();
            assert_eq!(receipt.kind, ProviderRetryAfterKind::HttpDate);
            assert_eq!(receipt.delay_ms, 7_000);
        }
        let past = parse_provider_retry_after(
            b"Sun, 06 Nov 1994 08:49:20 GMT",
            observed + Duration::from_secs(20),
        )
        .unwrap();
        assert_eq!(past.delay_ms, 0);
    }

    #[test]
    fn rejects_whitespace_non_utf8_invalid_dates_and_overflow() {
        for value in [
            b" 120".as_slice(),
            b"120 ".as_slice(),
            b"tomorrow".as_slice(),
            &[0xff],
            &[],
        ] {
            assert_eq!(
                parse_provider_retry_after(value, UNIX_EPOCH),
                Err(ProviderRetryAfterError::Invalid)
            );
        }
        assert_eq!(
            parse_provider_retry_after(b"18446744073709551615", UNIX_EPOCH),
            Err(ProviderRetryAfterError::DelayOverflow)
        );
        let oversized = vec![b'1'; 513];
        assert_eq!(
            parse_provider_retry_after(&oversized, UNIX_EPOCH),
            Err(ProviderRetryAfterError::Invalid)
        );
    }
}
