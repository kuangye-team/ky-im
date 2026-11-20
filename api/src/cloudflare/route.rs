use super::store::{Owner, SHARDS, Store, now};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use tokio::sync::Mutex;
use worker::*;

#[durable_object]
pub struct PeerRoute {
    db: Store,
    changes: Mutex<()>,
}
#[derive(Serialize, Deserialize)]
struct Locator {
    id: String,
    room: String,
    sid: String,
}
impl From<&Owner> for Locator {
    fn from(o: &Owner) -> Self {
        Self {
            id: o.profile.id.clone(),
            room: o.room.clone(),
            sid: o.sid.clone(),
        }
    }
}
#[derive(Serialize, Deserialize)]
struct Job {
    old: Option<Owner>,
    next: Option<Owner>,
    before: Vec<Locator>,
    command: Value,
    committed: bool,
}

impl PeerRoute {
    async fn record(&self, owner: &Owner, n: &str, member: bool, add: bool) -> Result<Option<u64>> {
        Ok(self
            .db
            .rpc(
                "NUMBERS",
                n,
                "record",
                &json!({"id":owner.profile.id,"sid":owner.sid,"member":member,"add":add}),
            )
            .await?
            .as_u64())
    }
    async fn change(&self, p: Value) -> Result<Value> {
        let _guard = self.changes.lock().await;
        self.finish().await?;
        let old = self.db.get::<Owner>("owner")?;
        let kind = p["type"].as_str().unwrap_or_default();
        let sid = p["sid"].as_str().unwrap_or_default();
        if kind != "join" && old.as_ref().is_none_or(|o| o.sid != sid) {
            return Ok(json!({"error":"session_replaced"}));
        }
        let before = self.db.neighbors(old.as_ref()).await?;
        let mut next = old.clone();
        if kind == "join" {
            next = Some(Owner {
                sid: sid.into(),
                room: p["roomKey"].as_str().unwrap().into(),
                profile: serde_json::from_value(p["profile"].clone())?,
                recent: serde_json::from_value(p["recentNumericIds"].clone())?,
                explicit: Default::default(),
                number_epoch: 1,
                number_revision: 0,
                pairs: Default::default(),
            });
        } else if kind == "leave" {
            next = None;
        } else if let Some(a) = next.as_mut() {
            let n = p["numericId"].as_str().unwrap_or_default();
            match kind {
                "change_numeric_id" => {
                    let revision = p["revision"].as_u64().unwrap();
                    if a.number() == n || revision <= a.number_revision {
                        return Ok(Value::Null);
                    }
                    a.number_revision = revision;
                    a.profile.numeric_id = Some(n.into());
                    for b in &before {
                        a.pairs.insert(b.profile.id.clone(), b.sid.clone());
                    }
                }
                "discover" => a.recent = serde_json::from_value(p["recentNumericIds"].clone())?,
                "connect_group" | "connect" => {
                    let group = self.db.rpc("NUMBERS", n, "lookup", &Value::Null).await?;
                    let ids: Vec<String> = serde_json::from_value(group["members"].clone())?;
                    if ids.is_empty() {
                        return Ok(json!({"error":"peer_unavailable"}));
                    }
                    if kind == "connect_group" {
                        a.explicit
                            .insert(n.into(), group["epoch"].as_u64().unwrap());
                    } else {
                        let Some(id) = p["expectedPeerId"].as_str() else {
                            return Ok(json!({"error":"identity_required"}));
                        };
                        if id == a.profile.id {
                            return Ok(json!({"error":"invalid_target"}));
                        }
                        if !ids.iter().any(|i| i == id) {
                            return Ok(json!({"error":"identity_changed"}));
                        }
                        let Some(b) = self.db.current(id).await?.filter(|b| b.number() == n) else {
                            return Ok(json!({"error":"peer_unavailable"}));
                        };
                        a.pairs.insert(id.into(), b.sid);
                    }
                }
                _ => return Ok(json!({"error":"invalid_message"})),
            }
        }
        self.db.wake(now() + 1000).await?;
        self.db.put(
            "job",
            &Job {
                old,
                next,
                before: before.iter().map(Locator::from).collect(),
                command: p,
                committed: false,
            },
        )?;
        self.finish().await
    }
    async fn finish(&self) -> Result<Value> {
        let Some(mut job) = self.db.get::<Job>("job")? else {
            return Ok(Value::Null);
        };
        let kind = job.command["type"].as_str().unwrap_or_default();
        if !job.committed {
            if let Some(a) = &mut job.next {
                let Some(epoch) = self.record(a, a.number(), true, true).await? else {
                    self.db.del("job")?;
                    return Ok(json!({"error":"room_full"}));
                };
                a.number_epoch = epoch;
                for n in a.groups() {
                    self.record(a, &n, false, true).await?;
                }
                if let Some(current) = self
                    .db
                    .get::<Owner>("owner")?
                    .filter(|old| old.sid == a.sid)
                {
                    for (id, sid) in current.pairs {
                        a.pairs.entry(id).or_insert(sid);
                    }
                }
                self.db.put("owner", a)?;
            } else {
                self.db.del("owner")?;
            }
            job.committed = true;
            self.db.put("job", &job)?;
        }
        let old = job.old.as_ref();
        let next = job.next.as_ref();
        if let Some(a) = old {
            if next.is_none_or(|b| b.sid != a.sid || b.number() != a.number()) {
                self.record(a, a.number(), true, false).await?;
            }
            for n in a.groups() {
                if next.is_none_or(|b| b.sid != a.sid || !b.groups().contains(&n)) {
                    self.record(a, &n, false, false).await?;
                }
            }
            if next.is_some_and(|b| b.sid != a.sid) {
                self.db.rpc("ROOMS", &a.room, "replace", &a.sid).await?;
            }
        }
        if let Some(a) = next {
            for (id, sid) in &a.pairs {
                self.db
                    .rpc(
                        "ROUTES",
                        id,
                        "remember",
                        &json!({"sid":sid,"peer":a.profile.id,"generation":a.sid}),
                    )
                    .await?;
            }
        }
        let id = &next.or(old).unwrap().profile.id;
        let after = self.db.neighbors(next).await?;
        let removed = job
            .before
            .iter()
            .filter(|b| !after.iter().any(|a| b.sid == a.sid))
            .collect::<Vec<_>>();
        for b in &removed {
            self.db
                .deliver(&b.room, &b.sid, json!({"type":"peer_left","id":id}))
                .await?;
        }
        let mut added = vec![];
        for b in &after {
            let is_new = !job.before.iter().any(|a| a.sid == b.sid);
            if is_new {
                added.push(&b.profile);
            }
            let packet = if kind == "join" || is_new {
                json!({"type":"peer_joined","peer":next.unwrap().profile})
            } else if kind == "change_numeric_id" {
                json!({"type":"numeric_id_changed","id":id,"previousNumericId":old.unwrap().number(),"numericId":next.unwrap().number(),"revision":job.command["revision"]})
            } else {
                continue;
            };
            self.db.deliver(&b.room, &b.sid, packet).await?;
        }
        if let Some(a) = next.filter(|_| kind == "change_numeric_id" && !added.is_empty()) {
            self.db
                .deliver(
                    &a.room,
                    &a.sid,
                    json!({"type":"discovery_updated","peers":added,"removedPeerIds":[]}),
                )
                .await?;
        }
        if old.map(|a| &a.sid) != next.map(|a| &a.sid) {
            self.db
                .report(format!("peer/{id}"), 0, 0, usize::from(next.is_some()))
                .await?;
        }
        self.db.del("job")?;
        Ok(match kind {
            "connect" => {
                json!({"peer":after.iter().find(|b|job.command["expectedPeerId"]==b.profile.id).map(|b|&b.profile)})
            }
            "discover" => {
                json!({"peers":added,"removedPeerIds":removed.iter().map(|b|&b.id).collect::<Vec<_>>()})
            }
            _ => {
                json!({"peers":after.iter().filter(|b|kind!="connect_group" || job.command["numericId"]==b.number()).map(|b|&b.profile).collect::<Vec<_>>()})
            }
        })
    }
    async fn global(&self) -> Result<Response> {
        let keys = (0..SHARDS)
            .map(|i| format!("@stats/{i}"))
            .collect::<Vec<_>>();
        match futures_util::future::try_join_all(
            keys.iter()
                .map(|k| self.db.rpc("ROUTES", k, "totals", &Value::Null)),
        )
        .await
        {
            Ok(rows) => {
                let sum = |k: &str| rows.iter().filter_map(|r| r[k].as_u64()).sum::<u64>();
                let v = json!({"ok":true,"scope":"global","asOf":now(),"connections":sum("connections"),"rooms":sum("rooms"),"peers":sum("peers")});
                self.db.put("snapshot", &v)?;
                Response::from_json(&v)
            }
            Err(_) => match self.db.get::<Value>("snapshot")? {
                Some(mut v) => {
                    v["stale"] = true.into();
                    Response::from_json(&v)
                }
                None => Ok(
                    Response::from_json(&json!({"ok":false,"error":"stats_unavailable"}))?
                        .with_status(503),
                ),
            },
        }
    }
}
impl DurableObject for PeerRoute {
    fn new(state: State, env: Env) -> Self {
        Self {
            db: Store::new(state, env),
            changes: Default::default(),
        }
    }
    async fn fetch(&self, mut req: Request) -> Result<Response> {
        let path = req.path();
        if path == "/api/health/details" {
            return self.global().await;
        }
        let p: Value = req.json().await?;
        let result = match path.as_str() {
            "/current" => serde_json::to_value(self.db.get::<Owner>("owner")?)?,
            "/change" => self.change(p).await?,
            "/remember" => {
                if let Some(mut owner) =
                    self.db.get::<Owner>("owner")?.filter(|a| p["sid"] == a.sid)
                {
                    owner.pairs.insert(
                        p["peer"].as_str().unwrap().into(),
                        p["generation"].as_str().unwrap().into(),
                    );
                    self.db.put("owner", &owner)?;
                }
                Value::Null
            }
            "/contribute" | "/totals" => {
                let sql = self.db.state.storage().sql();
                sql.exec("CREATE TABLE IF NOT EXISTS stats(source TEXT PRIMARY KEY,seq INTEGER,connections INTEGER,rooms INTEGER,peers INTEGER)",None)?;
                if path == "/contribute" {
                    sql.exec("INSERT INTO stats VALUES(?,?,?,?,?) ON CONFLICT(source) DO UPDATE SET seq=excluded.seq, connections=excluded.connections, rooms=excluded.rooms, peers=excluded.peers WHERE excluded.seq>stats.seq",
                        vec![p["source"].as_str().unwrap().into(),p["seq"].as_i64().unwrap().into(),p["connections"].as_i64().unwrap().into(),p["rooms"].as_i64().unwrap().into(),p["peers"].as_i64().unwrap().into()])?;
                    Value::Null
                } else {
                    sql.exec("SELECT COALESCE(SUM(connections),0) AS connections, COALESCE(SUM(rooms),0) AS rooms, COALESCE(SUM(peers),0) AS peers FROM stats",None)?.one::<Value>()?
                }
            }
            _ => return Response::error("Unknown route operation", 404),
        };
        Response::from_json(&result)
    }
    async fn alarm(&self) -> Result<Response> {
        let _guard = self.changes.lock().await;
        self.finish().await?;
        self.db.flush_report().await?;
        Response::empty()
    }
}
