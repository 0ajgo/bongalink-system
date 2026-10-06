mod db;
mod features;
mod routes;
mod stock;
mod trend;

use std::{path::PathBuf, sync::Arc};

use anyhow::Context;
use tower_http::{cors::CorsLayer, trace::TraceLayer};

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    dotenvy::dotenv().ok();
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env().unwrap_or_else(|_| "info,tower_http=info".into()),
        )
        .init();

    let models_dir = PathBuf::from(std::env::var("MODELS_DIR").unwrap_or_else(|_| "models".into()));
    let ml = routes::Ml {
        stock: stock::StockModel::from_file(&models_dir.join("stock_lr.json"))?,
        trend: trend::TrendConfig::from_file(&models_dir.join("trend_config.json"))?,
    };
    tracing::info!(
        stock_model = %ml.stock.trained_with,
        trend_threshold = ml.trend.relative_change_threshold,
        "models loaded"
    );

    let database_url = std::env::var("DATABASE_URL").context("DATABASE_URL is not set (see .env.example)")?;
    // Lazy: the server starts even if MySQL is down; DB-backed endpoints fail until it's reachable.
    let pool = sqlx::mysql::MySqlPoolOptions::new().max_connections(10).connect_lazy(&database_url)?;

    let app = routes::router(routes::AppState { pool, ml: Arc::new(ml) })
        .layer(TraceLayer::new_for_http())
        .layer(CorsLayer::permissive()); // dev only: restrict to the frontend origin before deployment

    let addr = std::env::var("BIND_ADDR").unwrap_or_else(|_| "127.0.0.1:8080".into());
    let listener = tokio::net::TcpListener::bind(&addr).await?;
    tracing::info!("listening on http://{addr}");
    axum::serve(listener, app).await?;
    Ok(())
}
