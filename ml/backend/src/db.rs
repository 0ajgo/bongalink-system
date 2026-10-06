use anyhow::Result;
use chrono::{Duration, Local, NaiveDate};
use sqlx::MySqlPool;

pub struct Product {
    pub product_id: i64,
    pub name: String,
    pub quantity: i64,
}

pub async fn get_product(pool: &MySqlPool, product_id: i64) -> Result<Option<Product>> {
    let row: Option<(i64, String, i32)> =
        sqlx::query_as("SELECT product_id, name, quantity FROM products WHERE product_id = ?")
            .bind(product_id)
            .fetch_optional(pool)
            .await?;
    Ok(row.map(|(product_id, name, quantity)| Product { product_id, name, quantity: quantity as i64 }))
}

pub async fn list_active_products(pool: &MySqlPool) -> Result<Vec<Product>> {
    let rows: Vec<(i64, String, i32)> =
        sqlx::query_as("SELECT product_id, name, quantity FROM products WHERE is_active = 1 ORDER BY product_id")
            .fetch_all(pool)
            .await?;
    Ok(rows
        .into_iter()
        .map(|(product_id, name, quantity)| Product { product_id, name, quantity: quantity as i64 })
        .collect())
}

/// Units sold per day for the `days` complete days before today (oldest first, zeros for no sales),
/// plus today's date (the first day being predicted).
/// "Sold" = paid, shipped or delivered — same definition as SALES_SQL in the notebook.
pub async fn daily_units(pool: &MySqlPool, product_id: i64, days: usize) -> Result<(Vec<f64>, NaiveDate)> {
    let today = Local::now().date_naive();
    let start = today - Duration::days(days as i64);
    let rows: Vec<(NaiveDate, i64)> = sqlx::query_as(
        "SELECT DATE(o.order_date) AS d, CAST(SUM(oi.quantity) AS SIGNED) AS units
         FROM order_items oi
         JOIN orders o ON o.order_id = oi.order_id
         WHERE oi.product_id = ?
           AND o.order_status IN ('paid', 'shipped', 'delivered')
           AND o.order_date >= ? AND o.order_date < ?
         GROUP BY DATE(o.order_date)",
    )
    .bind(product_id)
    .bind(start)
    .bind(today)
    .fetch_all(pool)
    .await?;

    let mut out = vec![0.0; days];
    for (date, units) in rows {
        let idx = (date - start).num_days();
        if (0..days as i64).contains(&idx) {
            out[idx as usize] = units as f64;
        }
    }
    Ok((out, today))
}
