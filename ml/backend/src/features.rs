//! Feature engineering for the stock-prediction model.
//! This MUST stay identical to `make_features` in colab/bongalink_training.ipynb.
//! `cargo test` checks it against models/parity.json exported by the notebook.

use anyhow::{ensure, Result};
use chrono::{Datelike, Duration, NaiveDate};

pub const WINDOW_DAYS: usize = 28;
pub const HORIZON_DAYS: usize = 7;
pub const FEATURE_NAMES: [&str; 6] = [
    "mean_7",
    "mean_14",
    "mean_28",
    "slope_14",
    "zero_ratio_28",
    "paydays_next_7",
];

pub fn days_in_month(d: NaiveDate) -> u32 {
    let (y, m) = if d.month() == 12 { (d.year() + 1, 1) } else { (d.year(), d.month() + 1) };
    NaiveDate::from_ymd_opt(y, m, 1)
        .and_then(|first_of_next| first_of_next.pred_opt())
        .map(|last| last.day())
        .expect("valid calendar date")
}

/// Philippine semi-monthly payday window: 14th-16th, last two days of the month, and the 1st.
pub fn is_payday(d: NaiveDate) -> bool {
    let day = d.day();
    matches!(day, 1 | 14 | 15 | 16) || day + 1 >= days_in_month(d)
}

pub fn mean(y: &[f64]) -> f64 {
    y.iter().sum::<f64>() / y.len() as f64
}

/// Least-squares slope of `y` against x = 0, 1, 2, ...
pub fn ols_slope(y: &[f64]) -> f64 {
    let n = y.len() as f64;
    let x_mean = (n - 1.0) / 2.0;
    let y_mean = mean(y);
    let (mut num, mut den) = (0.0, 0.0);
    for (i, v) in y.iter().enumerate() {
        let x = i as f64 - x_mean;
        num += x * (v - y_mean);
        den += x * x;
    }
    num / den
}

/// `history`: last 28 days of units sold, oldest first. `target_start`: first day being predicted.
pub fn make_features(history: &[f64], target_start: NaiveDate) -> Result<[f64; 6]> {
    ensure!(
        history.len() == WINDOW_DAYS,
        "expected {WINDOW_DAYS} days of history, got {}",
        history.len()
    );
    let h = history;
    let zero_ratio = h.iter().filter(|v| **v == 0.0).count() as f64 / WINDOW_DAYS as f64;
    let paydays = (0..HORIZON_DAYS as i64)
        .filter(|i| is_payday(target_start + Duration::days(*i)))
        .count() as f64;
    Ok([
        mean(&h[WINDOW_DAYS - 7..]),
        mean(&h[WINDOW_DAYS - 14..]),
        mean(h),
        ols_slope(&h[WINDOW_DAYS - 14..]),
        zero_ratio,
        paydays,
    ])
}

#[cfg(test)]
mod tests {
    use super::*;

    fn d(y: i32, m: u32, day: u32) -> NaiveDate {
        NaiveDate::from_ymd_opt(y, m, day).unwrap()
    }

    #[test]
    fn payday_window() {
        assert!(is_payday(d(2026, 10, 15)));
        assert!(is_payday(d(2026, 10, 30)));
        assert!(is_payday(d(2026, 10, 31)));
        assert!(is_payday(d(2026, 2, 27))); // Feb has 28 days in 2026
        assert!(is_payday(d(2026, 11, 1)));
        assert!(!is_payday(d(2026, 10, 20)));
    }

    #[test]
    fn slope_of_straight_line() {
        let y: Vec<f64> = (0..14).map(|i| 2.0 + 0.5 * i as f64).collect();
        assert!((ols_slope(&y) - 0.5).abs() < 1e-12);
    }

    #[test]
    fn matches_notebook_features() {
        #[derive(serde::Deserialize)]
        struct Parity {
            history: Vec<f64>,
            target_start: NaiveDate,
            features: Vec<f64>,
        }
        let p: Parity = serde_json::from_str(include_str!("../models/parity.json")).unwrap();
        let hist = &p.history[p.history.len() - WINDOW_DAYS..];
        let f = make_features(hist, p.target_start).unwrap();
        for (i, (rust, py)) in f.iter().zip(&p.features).enumerate() {
            assert!((rust - py).abs() < 1e-9, "{}: rust {rust} vs notebook {py}", FEATURE_NAMES[i]);
        }
    }
}
