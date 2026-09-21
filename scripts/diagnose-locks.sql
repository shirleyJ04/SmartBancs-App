SELECT now() AS checked_at;

SELECT
  a.pid,
  a.usename,
  a.state,
  a.wait_event_type,
  a.wait_event,
  a.backend_start,
  a.xact_start,
  now() - a.xact_start AS xact_age,
  a.query_start,
  left(a.query, 300) AS query
FROM pg_stat_activity a
WHERE a.datname = current_database()
  AND a.pid <> pg_backend_pid()
ORDER BY a.xact_start NULLS LAST;

SELECT
  blocked.pid AS blocked_pid,
  left(blocked.query, 200) AS blocked_query,
  blocking.pid AS blocking_pid,
  left(blocking.query, 200) AS blocking_query,
  pg_blocking_pids(blocked.pid) AS blocking_pids
FROM pg_stat_activity blocked
JOIN pg_stat_activity blocking ON blocking.pid = ANY (pg_blocking_pids(blocked.pid))
WHERE blocked.datname = current_database();

SELECT
  l.locktype,
  l.relation::regclass AS relation,
  l.mode,
  l.granted,
  l.pid,
  left(a.query, 200) AS query
FROM pg_locks l
JOIN pg_stat_activity a ON a.pid = l.pid
WHERE a.datname = current_database()
  AND l.relation IS NOT NULL
ORDER BY l.granted, l.pid;
