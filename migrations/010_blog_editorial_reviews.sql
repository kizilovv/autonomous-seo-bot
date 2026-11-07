CREATE TABLE IF NOT EXISTS blog_editorial_reviews (
 id INTEGER PRIMARY KEY AUTOINCREMENT,
 blog_id INTEGER NOT NULL,
 decision TEXT NOT NULL CHECK(decision IN ('publish','reject')),
 review_json TEXT NOT NULL,
 created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS blog_editorial_reviews_blog ON blog_editorial_reviews(blog_id);
