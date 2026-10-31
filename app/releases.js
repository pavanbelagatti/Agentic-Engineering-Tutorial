// The "releases" of payments-api. v2.4.1 ships a config regression:
// the DB connection pool drops from 20 to 2, so under normal traffic
// requests queue for a connection and time out.
export const RELEASES = {
  "2.3.2": {
    dbPoolSize: 20,
    commit: "a41f9c2",
    summary: "Add idempotency keys to refunds",
  },
  "2.4.0": {
    dbPoolSize: 20,
    commit: "7be21d0",
    summary: "Support partial captures for card payments",
  },
  "2.4.1": {
    dbPoolSize: 2,
    commit: "c93e5af",
    summary: "Refactor DB client: lower connection pool defaults to reduce idle connections",
  },
};

export const GOOD_VERSION = "2.4.0";
export const BAD_VERSION = "2.4.1";
