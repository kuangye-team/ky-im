use serde::{Deserialize, Serialize, de::DeserializeOwned};
use serde_json::{Value, json};
use worker::*;

pub(super) const SHARDS: u32 = 8;
pub(super) struct Store {
    pub state: State,
    pub env: Env,
}
#[derive(Deserialize)]
struct Row {
    v: String,
}
impl Store {
    pub fn new(state: State, env: Env) -> Self {
        state
            .storage()
            .sql()
            .exec(
                "CREATE TABLE IF NOT EXISTS records(k TEXT PRIMARY KEY,v TEXT NOT NULL)",
                None,
            )
            .expect("initialize actor storage");
        Self { state, env }
    }
    pub fn get<T: DeserializeOwned>(&self, key: &str) -> Result<Option<T>> {
        let rows = self
            .state
            .storage()
            .sql()
            .exec("SELECT v FROM records WHERE k=?", vec![key.into()])?
            .to_array::<Row>()?;
        Ok(rows
            .first()
            .map(|row| serde_json::from_str(&row.v))
            .transpose()?)
    }
    pub fn put<T: Serialize>(&self, key: &str, value: &T) -> Result<()> {
        self.state.storage().sql().exec(
            "INSERT OR REPLACE INTO records VALUES(?,?)",
            vec![key.into(), serde_json::to_string(value)?.into()],
        )?;
        Ok(())
    }
    pub fn del(&self, key: &str) -> Result<()> {
        self.state
            .storage()
            .sql()
            .exec("DELETE FROM records WHERE k=?", vec![key.into()])?;
        Ok(())
    }
    pub fn list<T: DeserializeOwned>(&self, prefix: &str) -> Result<Vec<T>> {
        self.state
            .storage()
            .sql()
            .exec(
                "SELECT v FROM records WHERE substr(k,1,length(?))=?",
                vec![prefix.into(), prefix.into()],
            )?
            .to_array::<Row>()?
            .into_iter()
            .map(|r| Ok(serde_json::from_str(&r.v)?))
            .collect()
    }
    pub async fn wake(&self, at: u64) -> Result<()> {
        let storage = self.state.storage();
        if storage.get_alarm().await?.is_none_or(|old| old > at as i64) {
            storage
                .set_alarm(ScheduledTime::new(js_sys::Date::new(&(at as f64).into())))
                .await?;
        }
        Ok(())
    }
    pub async fn report(
        &self,
        key: String,
        connections: usize,
        rooms: usize,
        peers: usize,
    ) -> Result<()> {
        let seq = self.get::<u64>("seq")?.unwrap_or(0) + 1;
        self.put("seq", &seq)?;
        self.put("report",&json!({ "source":key,"seq":seq,"connections":connections,"rooms":rooms,"peers":peers }))?;
        self.wake(now() + 1000).await
    }
    pub async fn flush_report(&self) -> Result<()> {
        if let Some(v) = self.get::<Value>("report")? {
            let hash = v["source"]
                .as_str()
                .unwrap()
                .bytes()
                .fold(0u32, |h, b| h.wrapping_mul(31).wrapping_add(b as u32));
            self.rpc(
                "ROUTES",
                &format!("@stats/{}", hash % SHARDS),
                "contribute",
                &v,
            )
            .await?;
            if self.get::<Value>("report")?.as_ref() == Some(&v) {
                self.del("report")?;
            }
        }
        Ok(())
    }
    pub async fn rpc(
        &self,
        binding: &str,
        key: &str,
        op: &str,
        data: &impl Serialize,
    ) -> Result<Value> {
        let mut init = RequestInit::new();
        init.with_method(Method::Post)
            .with_body(Some(serde_json::to_string(data)?.into()));
        let req = Request::new_with_init(&format!("https://internal/{op}"), &init)?;
        let mut response = self
            .env
            .durable_object(binding)?
            .get_by_name(key)?
            .fetch_with_request(req)
            .await?;
        if response.status_code() != 200 {
            return Err(Error::RustError(format!("Internal {op} failed")));
        }
        response.json().await
    }
}
pub(super) fn now() -> u64 {
    js_sys::Date::now() as u64
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub(super) struct Owner {
    pub sid: String,
    pub room: String,
    pub profile: crate::protocol::Profile,
    pub recent: std::collections::BTreeSet<String>,
    pub explicit: std::collections::BTreeMap<String, u64>,
    #[serde(default)]
    pub number_epoch: u64,
    #[serde(default)]
    pub number_revision: u64,
    pub pairs: std::collections::BTreeMap<String, String>,
}
impl Owner {
    pub fn number(&self) -> &str {
        self.profile
            .numeric_id
            .as_deref()
            .expect("validated number")
    }
    pub fn groups(&self) -> std::collections::BTreeSet<String> {
        self.recent
            .iter()
            .chain(self.explicit.keys())
            .filter(|n| n.as_str() != self.number())
            .cloned()
            .collect()
    }
    fn subscribes_to(&self, b: &Owner) -> bool {
        self.recent.contains(b.number()) || self.explicit.get(b.number()) == Some(&b.number_epoch)
    }
    pub fn visible(&self, b: &Owner) -> bool {
        self.profile.id != b.profile.id
            && (self.room == b.room
                || self.number() == b.number()
                || self.subscribes_to(b)
                || b.subscribes_to(self)
                || self.pairs.get(&b.profile.id) == Some(&b.sid)
                || b.pairs.get(&self.profile.id) == Some(&self.sid))
    }
}
impl Store {
    pub async fn current(&self, id: &str) -> Result<Option<Owner>> {
        Ok(serde_json::from_value(
            self.rpc("ROUTES", id, "current", &Value::Null).await?,
        )?)
    }
    pub async fn neighbors(&self, owner: Option<&Owner>) -> Result<Vec<Owner>> {
        let Some(a) = owner else {
            return Ok(Vec::new());
        };
        let groups = a.groups();
        let mut lists = vec![
            self.rpc("ROOMS", &a.room, "members", &Value::Null),
            self.rpc("NUMBERS", a.number(), "observers", &Value::Null),
        ];
        for n in &groups {
            lists.push(self.rpc("NUMBERS", n, "members", &Value::Null));
        }
        let mut ids = a
            .pairs
            .keys()
            .cloned()
            .collect::<std::collections::BTreeSet<_>>();
        for list in futures_util::future::try_join_all(lists).await? {
            ids.extend(serde_json::from_value::<Vec<String>>(list)?);
        }
        ids.remove(&a.profile.id);
        let peers =
            futures_util::future::try_join_all(ids.iter().map(|id| self.current(id))).await?;
        Ok(peers
            .into_iter()
            .flatten()
            .filter(|b| a.visible(b))
            .collect())
    }
    pub async fn deliver(&self, room: &str, sid: &str, message: Value) -> Result<bool> {
        Ok(self
            .rpc(
                "ROOMS",
                room,
                "deliver",
                &json!({"sid":sid,"message":message}),
            )
            .await?
            == true)
    }
}
