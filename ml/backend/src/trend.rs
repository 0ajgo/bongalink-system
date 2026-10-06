//! Algorithm 2: trend shift detection by segmented (two-piece) linear regression.
//!
//! Fits  units(x) ~ a + b*x + c*max(0, x - k)  to the last `window_days` of sales and picks the
//! breakpoint k with the lowest squared error (exact search, so always the global optimum).
//! The shift threshold is calibrated in the Colab notebook and loaded from models/trend_config.json.
//! Must stay identical to `fit_breakpoint` / `detect_shift` in the notebook.

use std::path::Path;

use anyhow::{ensure, Context, Result};
use serde::{Deserialize, Serialize};

use crate::features::mean;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TrendConfig {
    pub window_days: usize,
    pub min_segment_days: usize,
    pub relative_change_threshold: f64,
    #[serde(default)]
    pub trained_at: String,
    #[serde(default)]
    pub metrics: serde_json::Value,
}

#[derive(Debug, Clone, Serialize)]
pub struct TrendShift {
    /// Index (0 = oldest day in the window) where the slope changes.
    pub breakpoint_index: usize,
    pub days_since_breakpoint: usize,
    /// Units/day change per day, before and after the breakpoint.
    pub slope_before: f64,
    pub slope_after: f64,
    /// Slope change divided by (average daily units + 1).
    pub relative_change: f64,
    pub shift_detected: bool,
    /// "upward", "downward", or "none".
    pub direction: &'static str,
}

struct Fit {
    k: usize,
    sse: f64,
    coef: [f64; 3],
}

impl TrendConfig {
    pub fn from_file(path: &Path) -> Result<Self> {
        let text = std::fs::read_to_string(path).with_context(|| format!("reading {}", path.display()))?;
        Self::from_json(&text).with_context(|| format!("loading {}", path.display()))
    }

    pub fn from_json(text: &str) -> Result<Self> {
        let c: Self = serde_json::from_str(text)?;
        ensure!(c.min_segment_days >= 2, "min_segment_days must be at least 2");
        ensure!(c.window_days > 2 * c.min_segment_days, "window_days too short for min_segment_days");
        ensure!(c.relative_change_threshold > 0.0, "relative_change_threshold must be positive");
        Ok(c)
    }

    /// `y`: last `window_days` of daily units sold, oldest first.
    pub fn detect(&self, y: &[f64]) -> Result<TrendShift> {
        ensure!(y.len() == self.window_days, "expected {} days of history, got {}", self.window_days, y.len());
        let fit = fit_breakpoint(y, self.min_segment_days).context("could not fit a breakpoint")?;
        let slope_before = fit.coef[1];
        let slope_after = fit.coef[1] + fit.coef[2];
        let relative_change = (slope_after - slope_before) / (mean(y) + 1.0);
        let shift_detected = relative_change.abs() >= self.relative_change_threshold;
        let direction = match (shift_detected, relative_change > 0.0) {
            (false, _) => "none",
            (true, true) => "upward",
            (true, false) => "downward",
        };
        Ok(TrendShift {
            breakpoint_index: fit.k,
            days_since_breakpoint: y.len() - 1 - fit.k,
            slope_before,
            slope_after,
            relative_change,
            shift_detected,
            direction,
        })
    }
}

fn fit_breakpoint(y: &[f64], min_segment: usize) -> Option<Fit> {
    let n = y.len();
    let mut best: Option<Fit> = None;
    for k in min_segment..n.saturating_sub(min_segment) {
        // Normal equations (A^T A) coef = A^T y with rows [1, x, max(0, x - k)].
        let mut ata = [[0.0f64; 3]; 3];
        let mut aty = [0.0f64; 3];
        for (i, v) in y.iter().enumerate() {
            let x = i as f64;
            let row = [1.0, x, (x - k as f64).max(0.0)];
            for r in 0..3 {
                aty[r] += row[r] * v;
                for c in 0..3 {
                    ata[r][c] += row[r] * row[c];
                }
            }
        }
        let Some(coef) = solve3(ata, aty) else { continue };
        let sse: f64 = y
            .iter()
            .enumerate()
            .map(|(i, v)| {
                let x = i as f64;
                let pred = coef[0] + coef[1] * x + coef[2] * (x - k as f64).max(0.0);
                (pred - v).powi(2)
            })
            .sum();
        if best.as_ref().map_or(true, |b| sse < b.sse) {
            best = Some(Fit { k, sse, coef });
        }
    }
    best
}

/// Gaussian elimination with partial pivoting for a 3x3 system.
fn solve3(mut a: [[f64; 3]; 3], mut b: [f64; 3]) -> Option<[f64; 3]> {
    for col in 0..3 {
        let piv = (col..3).max_by(|&i, &j| a[i][col].abs().total_cmp(&a[j][col].abs()))?;
        if a[piv][col].abs() < 1e-12 {
            return None;
        }
        a.swap(col, piv);
        b.swap(col, piv);
        for row in col + 1..3 {
            let f = a[row][col] / a[col][col];
            for c in col..3 {
                let v = a[col][c];
                a[row][c] -= f * v;
            }
            let v = b[col];
            b[row] -= f * v;
        }
    }
    let mut x = [0.0; 3];
    for i in (0..3).rev() {
        let mut s = b[i];
        for c in i + 1..3 {
            s -= a[i][c] * x[c];
        }
        x[i] = s / a[i][i];
    }
    Some(x)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn finds_exact_breakpoint_on_clean_data() {
        // Flat at 5 for 40 days, then rising 0.5/day.
        let y: Vec<f64> = (0..84).map(|i| if i <= 40 { 5.0 } else { 5.0 + 0.5 * (i - 40) as f64 }).collect();
        let fit = fit_breakpoint(&y, 14).unwrap();
        assert_eq!(fit.k, 40);
        assert!(fit.coef[1].abs() < 1e-7 && (fit.coef[2] - 0.5).abs() < 1e-7);
    }

    #[test]
    fn matches_notebook_trend() {
        #[derive(Deserialize)]
        struct Expected {
            breakpoint_index: usize,
            slope_before: f64,
            slope_after: f64,
            relative_change: f64,
            shift_detected: bool,
        }
        #[derive(Deserialize)]
        struct Parity {
            history: Vec<f64>,
            trend: Expected,
        }
        let cfg = TrendConfig::from_json(include_str!("../models/trend_config.json")).unwrap();
        let p: Parity = serde_json::from_str(include_str!("../models/parity.json")).unwrap();
        let t = cfg.detect(&p.history).unwrap();
        assert_eq!(t.breakpoint_index, p.trend.breakpoint_index);
        assert!((t.slope_before - p.trend.slope_before).abs() < 1e-9);
        assert!((t.slope_after - p.trend.slope_after).abs() < 1e-9);
        assert!((t.relative_change - p.trend.relative_change).abs() < 1e-9);
        assert_eq!(t.shift_detected, p.trend.shift_detected);
    }
}
