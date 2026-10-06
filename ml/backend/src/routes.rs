use std::sync::Arc;

use axum::{
    extract::{Path, State},
    http::StatusCode,
    response::{IntoResponse, Response},
    routing::{get, post},
    Json, Router,
};
use chrono::{Local, NaiveDate};
use serde::{Deserialize, Serialize};
use serde_json::json;

use crate::{
    db,
    features::WINDOW_DAYS,
    stock::{StockForecast, StockModel},
    trend::{TrendConfig, TrendShift},
};

pub struct Ml {
    pub stock: StockModel,
    pub trend: TrendConfig,
}

#[derive(Clone)]
pub struct AppState {
    pub pool: sqlx::MySqlPool,
    pub ml: Arc<Ml>,
}

// TODO(Sprint 5 / REQ029): put /api/ml/* behind admin-only RBAC once auth is in place.
pub fn router(state: AppState) -> Router {
    Router::new()
        .route("/health", get(|| async { "ok" }))
        .route("/api/ml/models", get(model_info))
        .route("/api/ml/insights", get(all_insights))
        .route("/api/ml/products/:product_id/insights", get(product_insights))
        .route("/api/ml/stock-forecast", post(stock_forecast))
        .route("/api/ml/trend", post(trend))
        .with_state(state)
}

#[derive(Serialize)]
struct ProductInsights {
    product_id: i64,
    name: String,
    stock_forecast: StockForecast,
    trend: TrendShift,
}

async fn build_insights(s: &AppState, p: db::Product) -> Result<ProductInsights, AppError> {
    let days = s.ml.trend.window_days.max(WINDOW_DAYS);
    let (history, today) = db::daily_units(&s.pool, p.product_id, days).await?;
    let stock_forecast = s.ml.stock.forecast(&history[days - WINDOW_DAYS..], today, p.quantity)?;
    let trend = s.ml.trend.detect(&history[days - s.ml.trend.window_days..])?;
    Ok(ProductInsights { product_id: p.product_id, name: p.name, stock_forecast, trend })
}

/// One product: 7-day demand forecast, stockout estimate, and trend shift.
async fn product_insights(
    State(s): State<AppState>,
    Path(product_id): Path<i64>,
) -> Result<Json<ProductInsights>, AppError> {
    let product = db::get_product(&s.pool, product_id)
        .await?
        .ok_or_else(|| AppError::not_found(format!("product {product_id} not found")))?;
    Ok(Json(build_insights(&s, product).await?))
}

/// Admin dashboard feed: every active product, most urgent restock first.
async fn all_insights(State(s): State<AppState>) -> Result<Json<Vec<ProductInsights>>, AppError> {
    let mut out = Vec::new();
    for product in db::list_active_products(&s.pool).await? {
        out.push(build_insights(&s, product).await?);
    }
    out.sort_by(|a, b| {
        let key = |p: &ProductInsights| p.stock_forecast.days_until_stockout.unwrap_or(f64::INFINITY);
        b.stock_forecast
            .reorder_recommended
            .cmp(&a.stock_forecast.reorder_recommended)
            .then(key(a).total_cmp(&key(b)))
    });
    Ok(Json(out))
}

#[derive(Deserialize)]
struct StockForecastRequest {
    /// Last 28 days of units sold, oldest first.
    history: Vec<f64>,
    current_stock: i64,
    /// First day being predicted (YYYY-MM-DD). Defaults to today.
    target_start: Option<NaiveDate>,
}

/// Run Algorithm 1 on supplied numbers (testing / demo without database data).
async fn stock_forecast(
    State(s): State<AppState>,
    Json(req): Json<StockForecastRequest>,
) -> Result<Json<StockForecast>, AppError> {
    validate_history(&req.history, WINDOW_DAYS)?;
    let start = req.target_start.unwrap_or_else(|| Local::now().date_naive());
    Ok(Json(s.ml.stock.forecast(&req.history, start, req.current_stock)?))
}

#[derive(Deserialize)]
struct TrendRequest {
    /// Last 84 days of units sold, oldest first.
    history: Vec<f64>,
}

/// Run Algorithm 2 on supplied numbers (testing / demo without database data).
async fn trend(State(s): State<AppState>, Json(req): Json<TrendRequest>) -> Result<Json<TrendShift>, AppError> {
    validate_history(&req.history, s.ml.trend.window_days)?;
    Ok(Json(s.ml.trend.detect(&req.history)?))
}

async fn model_info(State(s): State<AppState>) -> Json<serde_json::Value> {
    Json(json!({ "stock_model": s.ml.stock, "trend_config": s.ml.trend }))
}

fn validate_history(history: &[f64], expected: usize) -> Result<(), AppError> {
    if history.len() != expected {
        return Err(AppError::bad_request(format!(
            "history must contain exactly {expected} daily values (oldest first), got {}",
            history.len()
        )));
    }
    if history.iter().any(|v| !v.is_finite() || *v < 0.0) {
        return Err(AppError::bad_request("history values must be non-negative numbers"));
    }
    Ok(())
}

pub struct AppError {
    status: StatusCode,
    message: String,
}

impl AppError {
    fn bad_request(message: impl Into<String>) -> Self {
        Self { status: StatusCode::BAD_REQUEST, message: message.into() }
    }
    fn not_found(message: impl Into<String>) -> Self {
        Self { status: StatusCode::NOT_FOUND, message: message.into() }
    }
}

impl IntoResponse for AppError {
    fn into_response(self) -> Response {
        (self.status, Json(json!({ "error": self.message }))).into_response()
    }
}

/// Unexpected errors are logged in full but only reported generically to the client.
impl<E: Into<anyhow::Error>> From<E> for AppError {
    fn from(err: E) -> Self {
        tracing::error!("{:#}", err.into());
        Self { status: StatusCode::INTERNAL_SERVER_ERROR, message: "internal server error".into() }
    }
}
