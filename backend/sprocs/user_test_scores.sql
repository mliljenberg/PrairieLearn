CREATE OR REPLACE VIEW user_test_scores AS
WITH
last_score_per_test_instance AS (
    SELECT DISTINCT
        ti.id,
        last_value(tsc.score_perc) OVER (PARTITION BY ti.id ORDER BY tsc.date, tsc.id) AS score_perc
    FROM test_scores AS tsc
    JOIN test_instances AS ti ON (ti.id = tsc.test_instance_id)
)
SELECT
    u.id AS user_id,
    t.id AS test_id,
    max(scores.score_perc) AS score_perc
FROM users AS u
JOIN test_instances AS ti ON (ti.user_id = u.id)
JOIN tests AS t ON (t.id = ti.test_id)
JOIN last_score_per_test_instance AS scores ON (scores.id = ti.id)
WHERE t.deleted_at IS NULL
GROUP BY u.id, t.id
;