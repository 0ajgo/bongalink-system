//! Algorithm 1: stock prediction via linear regression.
//! Weights are trained in Google Colab with TensorFlow and exported to models/stock_lr.json.

use std::path::Path;

use anyhow::{ensure, Context, Result};
use chrono::NaiveDate;
use serde::{Deserialize, Serialize};

use crate::features::{make_features, FEATURE_NAMES, HORIZON_DAYS, WINDOW_DAYS};

/// Suggested reorders aim to keep this many days of predicted demand on hand.
const COVER_DAYS: f64 = 14.0;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct StockModel {
    pub model: String,
    #[serde(default)]
    pub trained_with: String,
    #[serde(default)]
    pub trained_at: String,
    pub window_days: usize,
    pub horizon_days: usize,
    pub feature_names: Vec<String>,
    pub feature_mean: Vec<f64>,
    pub feature_std: Vec<f64>,
    pub weights: Vec<f64>,
    pub bias: f64,
    #[serde(default)]
    pub metrics: serde_json::Value,
}

#[derive(Debug, Clone, Serialize)]
pub struct StockForecast {
    /// Predicted units sold over the next 7 days.
    pub predicted_demand_7d: f64,
    pub avg_daily_demand: f64,
    pub current_stock: i64,
    /// Days until the current stock runs out at the predicted rate. None = no predicted demand.
    pub days_until_stockout: Option<f64>,
    pub reorder_recommended: bool,
    pub suggested_reorder_qty: i64,
}

impl StockModel {
    pub fn from_file(path: &Path) -> Result<Self> {
        let text = std::fs::read_to_string(path).with_context(|| format!("reading {}", path.display()))?;
        Self::from_json(&text).with_context(|| format!("loading {}", path.display()))
    }

    pub fn from_json(text: &str) -> Result<Self> {
        let m: Self = serde_json::from_str(text)?;
        ensure!(m.window_days == WINDOW_DAYS, "model window_days {} != backend {WINDOW_DAYS}", m.window_days);
        ensure!(m.horizon_days == HORIZON_DAYS, "model horizon_days {} != backend {HORIZON_DAYS}", m.horizon_days);
        ensure!(
            m.feature_names.iter().map(String::as_str).eq(FEATURE_NAMES.iter().copied()),
            "model features {:?} do not match backend features {:?}",
            m.feature_names,
            FEATURE_NAMES
        );
        let n = FEATURE_NAMES.len();
        ensure!(
            m.feature_mean.len() == n && m.feature_std.len() == n && m.weights.len() == n,
            "model vectors must all have {n} entries"
        );
        ensure!(m.feature_std.iter().all(|s| *s > 0.0), "feature_std must be positive");
        Ok(m)
    }

    /// Predicted units sold over the HORIZON_DAYS starting at `target_start`.
    pub fn predict_demand(&self, history: &[f64], target_start: NaiveDate) -> Result<f64> {
        let f = make_features(history, target_start)?;
        let mut y = 0.0;
        for i in 0..f.len() {
            y += (f[i] - self.feature_mean[i]) / self.feature_std[i] * self.weights[i];
        }
        Ok((y + self.bias).max(0.0))
    }

    pub fn forecast(&self, history: &[f64], target_start: NaiveDate, current_stock: i64) -> Result<StockForecast> {
        let demand = self.predict_demand(history, target_start)?;
        let daily = demand / HORIZON_DAYS as f64;
        let stock = current_stock.max(0) as f64;
        let days_until_stockout = (daily > 0.0).then(|| round1(stock / daily));
        let reorder_recommended =
            current_stock <= 0 || days_until_stockout.is_some_and(|d| d < HORIZON_DAYS as f64);
        let suggested_reorder_qty = ((daily * COVER_DAYS).ceil() as i64 - current_stock.max(0)).max(0);
        Ok(StockForecast {
            predicted_demand_7d: round2(demand),
            avg_daily_demand: round2(daily),
            current_stock,
            days_until_stockout,
            reorder_recommended,
            suggested_reorder_qty: if reorder_recommended { suggested_reorder_qty } else { 0 },
        })
    }
}

fn round1(v: f64) -> f64 {
    (v * 10.0).round() / 10.0
}
fn round2(v: f64) -> f64 {
    (v * 100.0).round() / 100.0
}

#[cfg(test)]
mod tests {
    use super::*;

    #[derive(Deserialize)]
    struct Parity {
        history: Vec<f64>,
        target_start: NaiveDate,
        predicted_demand_7d: f64,
    }

    #[test]
    fn matches_notebook_prediction() {
        let model = StockModel::from_json(include_str!("../models/stock_lr.json")).unwrap();
        let p: Parity = serde_json::from_str(include_str!("../models/parity.json")).unwrap();
        let hist = &p.history[p.history.len() - WINDOW_DAYS..];
        let pred = model.predict_demand(hist, p.target_start).unwrap();
        assert!((pred - p.predicted_demand_7d).abs() < 1e-9, "rust {pred} vs notebook {}", p.predicted_demand_7d);
    }

    #[test]
    fn out_of_stock_always_recommends_reorder() {
        let model = StockModel::from_json(include_str!("../models/stock_lr.json")).unwrap();
        let hist = vec![3.0; WINDOW_DAYS];
        let f = model.forecast(&hist, NaiveDate::from_ymd_opt(2026, 10, 6).unwrap(), 0).unwrap();
        assert!(f.reorder_recommended);
        assert!(f.suggested_reorder_qty > 0);
    }
}
