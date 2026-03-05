# TmuxDeck Cloud Relay - Design Document

## Problem

Today, connecting to a TmuxDeck instance requires direct network access:

- **LAN**: Browser/iPad connects to `192.168.x.x:8000` - works only on same network
- **Tailscale/VPN**: User configures VPN, enters Tailscale IP - requires setup on every device
- **Bridge agents**: Connect back to the backend via WebSocket - but the backend itself still needs to be reachable by the client

This means users must deal with port forwarding, VPN configuration, or being on the same network. A cloud relay eliminates all of that.

## Solution: Cloud Relay

A hosted relay service that both TmuxDeck servers and clients connect **outbound** to. No port forwarding, no VPN, no firewall rules.

```
+------------------+          +-------------------+          +------------------+
|  TmuxDeck Server |  ------> |   Cloud Relay     | <------  |  Browser / iPad  |
|  (home/office)   |  WS out  |   (relay.tmux.io) |  HTTPS   |  (anywhere)      |
+------------------+          +-------------------+          +------------------+
```

Both sides connect outbound. The relay matches them together and proxies traffic.

---

## User Flow

Simple, three-step setup:

### 1. Register / Login

User creates an account on the relay dashboard (LiveView app at `relay.tmuxdeck.io`).

### 2. Create Instance

User clicks "New Instance" in the dashboard. The relay creates an instance and shows:

- **Instance Token**: `tdck_abc123def456...` (shown once, copy it now)
- **Relay URL**: `wss://relay.tmuxdeck.io`

### 3. Configure TmuxDeck

User adds two env vars to their TmuxDeck deployment:

```bash
RELAY_URL=wss://relay.tmuxdeck.io
RELAY_TOKEN=tdck_abc123def456...
```

TmuxDeck connects to the relay. Done. The dashboard shows the instance as "online" and displays the public URL:

```
https://<instance_id>.relay.tmuxdeck.io
```

The user (or anyone with the URL + TmuxDeck PIN) can now access their TmuxDeck from anywhere.

```
                  Dashboard (LiveView)
                  +----------------------------------+
                  |  My Instances                    |
                  |                                  |
                  |  homelab        [online]         |
                  |  url: abc123.relay.tmuxdeck.io   |
                  |                                  |
                  |  work-server    [offline]        |
                  |  last seen: 2h ago               |
                  |                                  |
                  |  [+ New Instance]                |
                  +----------------------------------+
```

---

## Why Elixir?

The BEAM VM is purpose-built for exactly this workload:

- **Massive concurrency**: Each tunnel, stream, and WebSocket is a lightweight process (~2KB each). A single relay node can handle 100k+ concurrent tunnels.
- **Fault isolation**: A crash in one tunnel process doesn't affect any other. OTP supervisors auto-restart failed processes.
- **Native WebSocket support**: Phoenix Channels and Cowboy/Bandit provide battle-tested WebSocket handling with built-in heartbeats, backpressure, and connection draining.
- **Hot code upgrades**: Deploy new relay versions without dropping existing tunnel connections.
- **Distribution**: BEAM nodes can cluster natively - tunnel state shared across nodes without Redis.
- **Low latency**: The BEAM scheduler is optimized for I/O-heavy workloads with soft real-time guarantees - perfect for terminal I/O relay.
- **Binary pattern matching**: Elixir's binary pattern matching makes parsing the multiplexed frame protocol trivial and fast.

---

## Architecture Overview

### Components

```
cloud-relay/
  relay/                         # Single Phoenix app (no umbrella for MVP)
    lib/
      relay/
        accounts/
          accounts.ex            # Register, login, verify
          account.ex             # Ecto schema
        instances/
          instances.ex           # Create, list, revoke tokens
          instance.ex            # Ecto schema
        tunnels/
          tunnel_server.ex       # GenServer per active tunnel
          tunnel_supervisor.ex   # DynamicSupervisor
        repo.ex
      relay_web/
        endpoint.ex
        router.ex
        channels/
          tunnel_channel.ex      # TmuxDeck instance tunnel WebSocket
        live/
          dashboard_live.ex      # Account dashboard (instances list)
          instance_live.ex       # Instance detail + token creation
          login_live.ex
          register_live.ex
        plugs/
          subdomain_plug.ex      # Extract instance_id from subdomain
          proxy_plug.ex          # Forward client requests through tunnel
    config/
    mix.exs
    flake.nix                    # Nix flake for building + NixOS module
    flake.lock
```

### Flow

```
1. User registers on relay dashboard
2. User clicks "New Instance" -> gets a token + relay URL
3. User sets RELAY_URL + RELAY_TOKEN in TmuxDeck env
4. TmuxDeck backend connects to relay via WebSocket, authenticates with token
5. Relay spawns a TunnelServer process for this instance
6. Clients connect to <instance_id>.relay.tmuxdeck.io
7. Relay proxies all HTTP/WS traffic through the tunnel to TmuxDeck
8. TmuxDeck's own PIN auth still protects the dashboard
```

---

## Detailed Design

### 1. Relay Server

**Tech stack**: Elixir 1.17+ / OTP 27+, Phoenix 1.7, Ecto, deployed on Fly.io / bare VPS

Each active tunnel is a `TunnelServer` GenServer process. Process registry via Elixir's built-in `Registry` module provides O(1) tunnel lookup by instance ID.

#### Supervision Tree

```
RelayApp
  |-- RelayWeb.Endpoint              # Phoenix/Bandit HTTP + WS
  |-- Relay.TunnelSupervisor         # DynamicSupervisor for tunnel processes
  |     |-- TunnelServer (abc123)    # One per connected instance
  |     |-- TunnelServer (def456)
  |     `-- ...
  |-- Relay.ClusterMonitor           # Monitors node joins/leaves
  `-- Relay.Repo                     # Ecto Postgres pool
```

#### TunnelServer (GenServer)

Each tunnel is a process that holds:
- The TmuxDeck agent's WebSocket PID
- Active stream map (`stream_id -> client_pid`)
- Instance metadata

```elixir
defmodule Relay.Tunnels.TunnelServer do
  use GenServer

  defstruct [
    :instance_id,
    :account_id,
    :agent_pid,
    :agent_monitor,
    streams: %{},          # stream_id => client_pid
    next_stream_id: 1,
    connected_at: nil
  ]

  def start_link(opts) do
    instance_id = Keyword.fetch!(opts, :instance_id)
    GenServer.start_link(__MODULE__, opts, name: via(instance_id))
  end

  defp via(instance_id) do
    {:via, Registry, {Relay.TunnelRegistry, instance_id}}
  end

  # Agent sends a frame destined for a client stream
  def handle_cast({:agent_frame, stream_id, frame_type, payload}, state) do
    case Map.get(state.streams, stream_id) do
      nil -> {:noreply, state}
      client_pid -> send(client_pid, {:tunnel_frame, frame_type, payload})
    end
    {:noreply, state}
  end

  # Client sends data to the agent through the tunnel
  def handle_cast({:client_frame, stream_id, frame_type, payload}, state) do
    frame = encode_frame(stream_id, frame_type, payload)
    send(state.agent_pid, {:send_frame, frame})
    {:noreply, state}
  end

  # Agent WebSocket went down
  def handle_info({:DOWN, ref, :process, _, _reason}, %{agent_monitor: ref} = state) do
    for {_id, pid} <- state.streams, do: send(pid, :tunnel_closed)
    {:stop, :normal, state}
  end
end
```

#### Tunnel Connection (Phoenix Channel)

TmuxDeck connects with its instance token:

```elixir
defmodule RelayWeb.TunnelChannel do
  use Phoenix.Channel

  def join("tunnel:connect", %{"token" => token}, socket) do
    case Relay.Instances.verify_token(token) do
      {:ok, instance} ->
        {:ok, _pid} = Relay.TunnelSupervisor.start_tunnel(
          instance_id: instance.instance_id,
          account_id: instance.account_id,
          agent_pid: socket.transport_pid
        )

        Relay.Instances.mark_online(instance)

        {:ok, %{
          instance_id: instance.instance_id,
          url: "https://#{instance.instance_id}.relay.tmuxdeck.io"
        }, assign(socket, :instance, instance)}

      {:error, :invalid_token} ->
        {:error, %{reason: "invalid_token"}}

      {:error, :revoked} ->
        {:error, %{reason: "token_revoked"}}
    end
  end

  # Binary frames from TmuxDeck -> route to correct client stream
  def handle_in("frame", {:binary, data}, socket) do
    <<stream_id::32, frame_type::8, payload::binary>> = data
    Relay.Tunnels.agent_frame(socket.assigns.instance.instance_id, stream_id, frame_type, payload)
    {:noreply, socket}
  end

  def terminate(_reason, socket) do
    Relay.Instances.mark_offline(socket.assigns.instance)
    :ok
  end
end
```

#### Client Request Proxying

When a client hits `https://abc123.relay.tmuxdeck.io/api/v1/containers`:

1. `SubdomainPlug` extracts `abc123` from the Host header
2. `ProxyPlug` looks up the `TunnelServer` process via Registry
3. Allocates a `stream_id`, serializes the HTTP request into a binary frame
4. Sends it through the tunnel to the TmuxDeck backend
5. TmuxDeck responds, response flows back as a frame
6. `ProxyPlug` reconstructs the HTTP response for the client

```elixir
defmodule RelayWeb.Plugs.ProxyPlug do
  import Plug.Conn

  def call(conn, _opts) do
    instance_id = conn.assigns[:instance_id]

    case Relay.Tunnels.lookup(instance_id) do
      nil ->
        conn |> send_resp(502, "Instance offline") |> halt()

      tunnel_pid ->
        {:ok, stream_id} = Relay.Tunnels.open_stream(tunnel_pid, self())
        request = serialize_request(conn)
        Relay.Tunnels.client_frame(tunnel_pid, stream_id, :http_request, request)

        receive do
          {:tunnel_frame, :http_response, response} ->
            send_proxied_response(conn, response)
        after
          30_000 ->
            conn |> send_resp(504, "Tunnel timeout") |> halt()
        end
    end
  end
end
```

For WebSocket upgrades (terminal connections), the relay establishes a bidirectional pipe:

```
Client WS <---> StreamProcess <---> TunnelServer <---> TmuxDeck WS
```

#### Multiplexed Tunnel Protocol

All traffic flows over a single WebSocket between TmuxDeck and the relay, multiplexed by stream ID:

```
Frame format (binary):
  <<stream_id::32, frame_type::8, payload::binary>>

Frame types:
  0x01 = HTTP_REQUEST   { method, path, headers, body }
  0x02 = HTTP_RESPONSE  { status, headers, body }
  0x03 = WS_OPEN        { path, headers }
  0x04 = WS_DATA        { data }  (text or binary)
  0x05 = WS_CLOSE       { code, reason }
  0x06 = STREAM_RESET   { reason }
  0x07 = PING
  0x08 = PONG
```

Elixir's binary pattern matching makes this natural:

```elixir
def parse_frame(<<stream_id::unsigned-32, 0x01, payload::binary>>),
  do: {:http_request, stream_id, decode_http_request(payload)}

def parse_frame(<<stream_id::unsigned-32, 0x04, payload::binary>>),
  do: {:ws_data, stream_id, payload}
```

### 2. TmuxDeck Integration (Relay Client)

Built directly into the TmuxDeck Python backend as an optional async task. No sidecar needed.

When `RELAY_URL` and `RELAY_TOKEN` are set, the backend spawns a relay client on startup:

```python
# backend/app/services/relay_client.py
class RelayClient:
    """Connects to cloud relay and proxies incoming requests to local server."""

    def __init__(self, relay_url: str, token: str, backend_url: str = "http://localhost:8000"):
        self.relay_url = relay_url
        self.token = token
        self.backend_url = backend_url
        self._streams: dict[int, asyncio.Task] = {}

    async def connect(self):
        """Connect to relay and join the tunnel channel."""
        async with websockets.connect(self.relay_url) as ws:
            # Join tunnel with token
            await ws.send(json.dumps({
                "topic": "tunnel:connect",
                "event": "phx_join",
                "payload": {"token": self.token},
                "ref": "1"
            }))
            reply = json.loads(await ws.recv())
            if reply.get("event") == "phx_reply" and reply["payload"]["status"] == "ok":
                logger.info("Relay connected: %s", reply["payload"]["response"]["url"])
                await self._handle_tunnel(ws)
            else:
                raise ConnectionError(f"Relay auth failed: {reply}")

    async def _handle_tunnel(self, ws):
        async for message in ws:
            if isinstance(message, bytes):
                stream_id, frame_type, payload = self._parse_frame(message)
                if frame_type == 0x01:  # HTTP_REQUEST
                    asyncio.create_task(self._proxy_http(ws, stream_id, payload))
                elif frame_type == 0x03:  # WS_OPEN
                    asyncio.create_task(self._proxy_ws_open(ws, stream_id, payload))
                elif frame_type == 0x04:  # WS_DATA
                    self._relay_ws_data(stream_id, payload)

    async def _proxy_http(self, ws, stream_id: int, request: dict):
        """Forward an HTTP request to local backend and send response back."""
        async with aiohttp.ClientSession() as session:
            async with session.request(
                method=request["method"],
                url=f"{self.backend_url}{request['path']}",
                headers=request.get("headers", {}),
                data=request.get("body"),
            ) as resp:
                body = await resp.read()
                response_frame = self._encode_frame(
                    stream_id, 0x02,
                    self._serialize_response(resp.status, dict(resp.headers), body)
                )
                await ws.send(response_frame)
```

#### Startup Integration

```python
# backend/app/main.py
@app.on_event("startup")
async def startup():
    # ... existing startup ...

    relay_url = os.getenv("RELAY_URL")
    relay_token = os.getenv("RELAY_TOKEN")
    if relay_url and relay_token:
        client = RelayClient(relay_url, relay_token)
        asyncio.create_task(client.connect_with_retry())
```

#### Docker Compose

```yaml
services:
  tmuxdeck:
    image: tmuxdeck/tmuxdeck:latest
    ports:
      - "8000:8000"          # still accessible locally
    environment:
      - RELAY_URL=wss://relay.tmuxdeck.io/ws/tunnel
      - RELAY_TOKEN=${RELAY_TOKEN}
    volumes:
      - /var/run/docker.sock:/var/run/docker.sock
```

No sidecar container needed. The relay client lives inside the existing backend process.

### 3. Dashboard (LiveView)

The relay dashboard is a Phoenix LiveView app. Simple, real-time, no separate frontend build.

#### Pages

- `/register` - Create account (email + password)
- `/login` - Sign in
- `/dashboard` - List instances, see online/offline status (real-time via PubSub)
- `/instances/new` - Create instance, shows token once
- `/instances/:id` - Instance detail (status, last seen, public URL, revoke token)

#### Instance Creation Flow

```elixir
defmodule RelayWeb.InstanceLive.New do
  use RelayWeb, :live_view

  def mount(_params, session, socket) do
    {:ok, assign(socket, token: nil, instance: nil)}
  end

  def handle_event("create", %{"name" => name}, socket) do
    account = socket.assigns.current_account

    case Relay.Instances.create(account, name) do
      {:ok, instance, raw_token} ->
        {:noreply, assign(socket, instance: instance, token: raw_token)}

      {:error, changeset} ->
        {:noreply, assign(socket, changeset: changeset)}
    end
  end

  def render(assigns) do
    ~H"""
    <div :if={@token}>
      <h2>Instance Created</h2>
      <p>Copy these values now. The token will not be shown again.</p>

      <div class="font-mono bg-zinc-900 p-4 rounded">
        <p>RELAY_URL=wss://relay.tmuxdeck.io/ws/tunnel</p>
        <p>RELAY_TOKEN=<%= @token %></p>
      </div>

      <p class="text-sm text-zinc-400 mt-2">
        Add these to your TmuxDeck .env file or Docker Compose environment.
      </p>
    </div>

    <form :if={!@token} phx-submit="create">
      <input type="text" name="name" placeholder="Instance name (e.g. homelab)" required />
      <button type="submit">Create Instance</button>
    </form>
    """
  end
end
```

#### Real-time Status

When a TmuxDeck instance connects/disconnects, the dashboard updates live:

```elixir
# In Relay.Instances
def mark_online(instance) do
  Repo.update(Ecto.Changeset.change(instance, %{status: "online", last_seen_at: DateTime.utc_now()}))
  Phoenix.PubSub.broadcast(Relay.PubSub, "account:#{instance.account_id}", {:instance_online, instance.id})
end

def mark_offline(instance) do
  Repo.update(Ecto.Changeset.change(instance, %{status: "offline", last_seen_at: DateTime.utc_now()}))
  Phoenix.PubSub.broadcast(Relay.PubSub, "account:#{instance.account_id}", {:instance_offline, instance.id})
end

# In DashboardLive
def mount(_params, _session, socket) do
  account = socket.assigns.current_account
  Phoenix.PubSub.subscribe(Relay.PubSub, "account:#{account.id}")
  instances = Relay.Instances.list(account)
  {:ok, assign(socket, instances: instances)}
end

def handle_info({:instance_online, instance_id}, socket) do
  instances = update_instance_status(socket.assigns.instances, instance_id, "online")
  {:noreply, assign(socket, instances: instances)}
end
```

### 4. Authentication

#### Account Auth (Relay Dashboard)

Standard email + password with `argon2_elixir`:

```elixir
defmodule Relay.Accounts do
  def register(email, password) do
    %Account{}
    |> Account.registration_changeset(%{email: email, password: password})
    |> Repo.insert()
  end

  def login(email, password) do
    case Repo.get_by(Account, email: email) do
      nil -> {:error, :not_found}
      account ->
        if Argon2.verify_pass(password, account.password_hash),
          do: {:ok, account},
          else: {:error, :invalid_password}
    end
  end
end
```

Session-based auth via `phx.gen.auth` patterns. No JWT complexity for the dashboard.

#### Instance Token Auth (Tunnel Connection)

Tokens are generated when creating an instance, stored hashed:

```elixir
defmodule Relay.Instances do
  def create(account, name) do
    instance_id = generate_instance_id()  # e.g., "a7b3c9"
    raw_token = "tdck_" <> Base.url_encode64(:crypto.strong_rand_bytes(32), padding: false)

    instance = %Instance{
      instance_id: instance_id,
      account_id: account.id,
      name: name,
      token_hash: Argon2.hash_pwd_salt(raw_token),
      token_prefix: String.slice(raw_token, 0, 12),
      status: "offline"
    }

    case Repo.insert(instance) do
      {:ok, instance} -> {:ok, instance, raw_token}  # raw_token shown once
      error -> error
    end
  end

  def verify_token(raw_token) do
    prefix = String.slice(raw_token, 0, 12)

    case Repo.get_by(Instance, token_prefix: prefix) do
      nil -> {:error, :invalid_token}
      %{revoked_at: %DateTime{}} -> {:error, :revoked}
      instance ->
        if Argon2.verify_pass(raw_token, instance.token_hash),
          do: {:ok, Repo.preload(instance, :account)},
          else: {:error, :invalid_token}
    end
  end

  def revoke_token(instance) do
    Repo.update(Ecto.Changeset.change(instance, %{revoked_at: DateTime.utc_now()}))
  end

  def regenerate_token(instance) do
    raw_token = "tdck_" <> Base.url_encode64(:crypto.strong_rand_bytes(32), padding: false)

    instance
    |> Ecto.Changeset.change(%{
      token_hash: Argon2.hash_pwd_salt(raw_token),
      token_prefix: String.slice(raw_token, 0, 12),
      revoked_at: nil
    })
    |> Repo.update()
    |> case do
      {:ok, instance} -> {:ok, instance, raw_token}
      error -> error
    end
  end
end
```

#### TmuxDeck PIN Auth

Still works. The relay is transparent - it just forwards requests. TmuxDeck's own PIN auth protects the dashboard end-to-end.

### 5. Self-Hosted Relay

The relay is designed to run on a single machine for the MVP. No clustering, no multi-region - just one NixOS box running everything.

---

## Data Model

### Ecto Schemas

```elixir
defmodule Relay.Accounts.Account do
  use Ecto.Schema

  schema "accounts" do
    field :email, :string
    field :password_hash, :string
    has_many :instances, Relay.Instances.Instance
    timestamps()
  end
end

defmodule Relay.Instances.Instance do
  use Ecto.Schema

  schema "instances" do
    field :instance_id, :string       # "a7b3c9" - used in subdomain
    field :name, :string              # "homelab", "work-server"
    field :token_hash, :string        # Argon2 hash of tdck_xxx...
    field :token_prefix, :string      # first 12 chars for lookup
    field :status, :string, default: "offline"  # "online" | "offline"
    field :last_seen_at, :utc_datetime
    field :relay_node, :string        # which BEAM node holds the tunnel
    field :revoked_at, :utc_datetime  # set when token is revoked
    field :metadata, :map, default: %{}  # agent version, OS, etc.
    belongs_to :account, Relay.Accounts.Account
    timestamps()
  end
end
```

### Migration

```elixir
defmodule Relay.Repo.Migrations.InitialSetup do
  use Ecto.Migration

  def change do
    execute "CREATE EXTENSION IF NOT EXISTS citext", ""

    create table(:accounts) do
      add :email, :citext, null: false
      add :password_hash, :string, null: false
      timestamps()
    end
    create unique_index(:accounts, [:email])

    create table(:instances) do
      add :account_id, references(:accounts, on_delete: :delete_all), null: false
      add :instance_id, :string, null: false
      add :name, :string, null: false
      add :token_hash, :string, null: false
      add :token_prefix, :string, null: false
      add :status, :string, null: false, default: "offline"
      add :last_seen_at, :utc_datetime
      add :relay_node, :string
      add :revoked_at, :utc_datetime
      add :metadata, :map, default: %{}
      timestamps()
    end
    create unique_index(:instances, [:instance_id])
    create index(:instances, [:account_id])
    create index(:instances, [:token_prefix])
  end
end
```

### ETS (Hot State)

No Redis. BEAM-native:

```elixir
# Tunnel registry - O(1) lookup by instance_id
Registry.start_link(keys: :unique, name: Relay.TunnelRegistry)

# Rate limiting via ETS counters
:ets.new(:rate_limits, [:set, :public, :named_table])
```

---

## iOS / Web App Integration

Connecting via relay requires no client changes. The relay URL *is* just a server URL:

```
+-----------------------------------+
|  Add Server                       |
|                                   |
|  Server Name: [homelab       ]    |
|  Server URL:  [abc123.relay.tmuxdeck.io] |
|                                   |
|  [Connect]                        |
+-----------------------------------+
```

The existing `ServerConfig.swift` already handles this - it prepends `http://` if missing, and derives the WebSocket URL from the scheme. The relay serves HTTPS, so the iOS app connects via `wss://` automatically.

The QR code flow also works unchanged - the relay dashboard can show a QR code with the instance URL.

---

## API Reference

### Dashboard (LiveView - browser only)

```
GET  /register          # Registration page
GET  /login             # Login page
GET  /dashboard         # Instance list (real-time)
GET  /instances/new     # Create new instance
GET  /instances/:id     # Instance detail
POST /instances/:id/revoke      # Revoke token
POST /instances/:id/regenerate  # Generate new token
DELETE /instances/:id           # Delete instance
```

### Tunnel WebSocket (TmuxDeck -> Relay)

```
WSS /ws/tunnel
  Join topic: "tunnel:connect" with %{token: "tdck_..."}
  <- server: {:ok, %{instance_id: "abc123", url: "https://abc123.relay.tmuxdeck.io"}}
  -> tmuxdeck: binary frames (multiplexed)
  <- server:   binary frames (multiplexed)
  <- server:   Phoenix heartbeat every 30s
```

### Client-Facing (Proxied)

All requests to `https://<instance_id>.relay.tmuxdeck.io/*` are transparently proxied to the TmuxDeck backend. The client sees the exact same API as a direct connection.

---

## Key Dependencies

```elixir
# mix.exs
defp deps do
  [
    {:phoenix, "~> 1.7"},
    {:phoenix_live_view, "~> 1.0"},
    {:ecto_sql, "~> 3.12"},
    {:postgrex, "~> 0.19"},
    {:argon2_elixir, "~> 4.0"},
    {:websock_adapter, "~> 0.5"},
    {:bandit, "~> 1.6"},
    {:telemetry_metrics, "~> 1.0"},
  ]
end
```

---

## Deployment: Single Machine NixOS

### MVP Architecture

For v1, everything runs on a **single NixOS machine**. No clustering, no multi-region, no container orchestration. Just systemd services managed by NixOS.

```
+--------------------------------------------------+
|  NixOS Server (e.g., Hetzner VPS)                |
|                                                   |
|  +-------------------+  +---------------------+  |
|  |  Caddy            |  |  PostgreSQL         |  |
|  |  (reverse proxy)  |  |  (NixOS service)    |  |
|  |  auto TLS via     |  +---------------------+  |
|  |  Let's Encrypt    |            |               |
|  +--------+----------+            |               |
|           |                       |               |
|  +--------+------------------------+              |
|  |  TmuxDeck Relay (Phoenix/BEAM)  |              |
|  |  systemd service                |              |
|  |  port 4000                      |              |
|  +---------------------------------+              |
+--------------------------------------------------+
```

### Nix Flake

The relay project ships a `flake.nix` that provides:
- A buildable package (`nix build`)
- A NixOS module for declarative deployment

```nix
# flake.nix
{
  description = "TmuxDeck Cloud Relay";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
    flake-utils.url = "github:numtide/flake-utils";
  };

  outputs = { self, nixpkgs, flake-utils }:
    flake-utils.lib.eachDefaultSystem (system:
      let
        pkgs = nixpkgs.legacyPackages.${system};
        beamPackages = pkgs.beam.packagesWith pkgs.beam.interpreters.erlang_27;
        elixir = beamPackages.elixir_1_17;
      in {
        packages.default = pkgs.stdenv.mkDerivation {
          pname = "tmuxdeck-relay";
          version = "0.1.0";
          src = ./.;

          nativeBuildInputs = [ elixir beamPackages.hex beamPackages.rebar3 pkgs.git ];

          buildPhase = ''
            export MIX_ENV=prod
            export HEX_OFFLINE=1
            mix local.hex --force
            mix local.rebar --force
            mix deps.get --only prod
            mix compile
            mix assets.deploy
            mix phx.gen.release
            mix release
          '';

          installPhase = ''
            mkdir -p $out
            cp -r _build/prod/rel/relay/* $out/
          '';
        };

        devShells.default = pkgs.mkShell {
          buildInputs = [
            elixir
            beamPackages.hex
            pkgs.postgresql_17
            pkgs.inotify-tools  # for Phoenix live reload
          ];
        };
      }
    ) // {
      # NixOS module
      nixosModules.default = { config, lib, pkgs, ... }:
        let
          cfg = config.services.tmuxdeck-relay;
        in {
          options.services.tmuxdeck-relay = {
            enable = lib.mkEnableOption "TmuxDeck Cloud Relay";

            domain = lib.mkOption {
              type = lib.types.str;
              example = "relay.tmuxdeck.io";
              description = "Domain for the relay service (wildcard *.domain routes tunnels)";
            };

            port = lib.mkOption {
              type = lib.types.port;
              default = 4000;
              description = "Port for the Phoenix app";
            };

            database = {
              name = lib.mkOption {
                type = lib.types.str;
                default = "tmuxdeck_relay";
              };
              user = lib.mkOption {
                type = lib.types.str;
                default = "relay";
              };
            };

            secretKeyBaseFile = lib.mkOption {
              type = lib.types.path;
              description = "Path to file containing SECRET_KEY_BASE";
            };
          };

          config = lib.mkIf cfg.enable {
            # PostgreSQL
            services.postgresql = {
              enable = true;
              package = pkgs.postgresql_17;
              ensureDatabases = [ cfg.database.name ];
              ensureUsers = [{
                name = cfg.database.user;
                ensureDBOwnership = true;
              }];
            };

            # Relay systemd service
            systemd.services.tmuxdeck-relay = {
              description = "TmuxDeck Cloud Relay";
              after = [ "network.target" "postgresql.service" ];
              wantedBy = [ "multi-user.target" ];

              environment = {
                PHX_HOST = cfg.domain;
                PORT = toString cfg.port;
                DATABASE_URL = "ecto:///${cfg.database.name}?socket_dir=/run/postgresql";
                MIX_ENV = "prod";
                RELEASE_NAME = "relay";
              };

              serviceConfig = {
                Type = "exec";
                ExecStartPre = "${self.packages.${pkgs.system}.default}/bin/relay eval 'Relay.Release.migrate()'";
                ExecStart = "${self.packages.${pkgs.system}.default}/bin/relay start";
                Restart = "on-failure";
                RestartSec = 5;
                DynamicUser = true;
                StateDirectory = "tmuxdeck-relay";
                EnvironmentFile = cfg.secretKeyBaseFile;
                # Hardening
                NoNewPrivileges = true;
                ProtectSystem = "strict";
                ProtectHome = true;
                PrivateTmp = true;
              };
            };

            # Caddy reverse proxy with automatic TLS
            services.caddy = {
              enable = true;
              virtualHosts = {
                "${cfg.domain}" = {
                  extraConfig = ''
                    reverse_proxy localhost:${toString cfg.port}
                  '';
                };
                "*.${cfg.domain}" = {
                  extraConfig = ''
                    tls {
                      dns cloudflare {env.CLOUDFLARE_API_TOKEN}
                    }
                    reverse_proxy localhost:${toString cfg.port}
                  '';
                };
              };
            };

            # Firewall
            networking.firewall.allowedTCPPorts = [ 80 443 ];
          };
        };
    };
}
```

### NixOS Server Configuration

On the NixOS server, the entire deployment is a few lines in `configuration.nix`:

```nix
# /etc/nixos/configuration.nix (or flake-based config)
{ inputs, ... }:
{
  imports = [
    inputs.tmuxdeck-relay.nixosModules.default
  ];

  services.tmuxdeck-relay = {
    enable = true;
    domain = "relay.tmuxdeck.io";
    secretKeyBaseFile = "/run/secrets/relay-secret-key";
  };
}
```

That's it. NixOS handles:
- PostgreSQL provisioned and configured
- Relay built from source and running as a systemd service
- Caddy with automatic TLS (wildcard cert via Cloudflare DNS challenge)
- Firewall rules
- Auto-migrations on startup
- Service restarts on failure

### Secret Management

```bash
# Generate the secret key base once
mix phx.gen.secret > /run/secrets/relay-secret-key

# Or use sops-nix / agenix for encrypted secrets in the repo
```

The `secretKeyBaseFile` is an environment file with:
```
SECRET_KEY_BASE=<your-generated-secret>
```

### Deploying Updates

```bash
# From dev machine - rebuild and switch
nixos-rebuild switch --flake .#relay-server --target-host root@relay.tmuxdeck.io
```

Or if using a CI/CD pipeline:
```bash
nix build .#packages.x86_64-linux.default
nix copy --to ssh://root@relay.tmuxdeck.io ./result
# Then on server: nixos-rebuild switch
```

### Why This Works for MVP

A single Hetzner CX22 (2 vCPU, 4GB RAM, ~$5/mo) can comfortably handle:
- Thousands of concurrent tunnel WebSocket connections (BEAM handles this effortlessly)
- PostgreSQL for accounts + instances (tiny dataset)
- Caddy for TLS termination
- All with sub-10ms proxy latency

Scale up to a bigger box when needed. Multi-node clustering is a Phase 3 concern.

---

## Implementation Roadmap

### Phase 1: MVP (Single NixOS Machine)

- [ ] Phoenix project setup (not umbrella)
- [ ] `flake.nix` with package build + NixOS module
- [ ] Account registration + login (phx.gen.auth)
- [ ] Instance CRUD + token generation (LiveView dashboard)
- [ ] `TunnelServer` GenServer + Registry
- [ ] `TunnelChannel` - TmuxDeck connects with token
- [ ] `SubdomainPlug` + `ProxyPlug` for HTTP proxying
- [ ] WebSocket proxying for terminal connections
- [ ] Relay client in TmuxDeck Python backend (`relay_client.py`)
- [ ] NixOS deployment config (Postgres + Caddy + relay service)
- [ ] Deploy to single Hetzner/OVH NixOS box

### Phase 2: Polish

- [ ] Real-time instance status in dashboard (PubSub)
- [ ] Token revocation + regeneration
- [ ] Instance metadata (version, OS, uptime)
- [ ] Rate limiting (ETS counters)
- [ ] QR code display in dashboard

### Phase 3: Growth

- [ ] Multi-node clustering via `libcluster` + `:pg`
- [ ] Plan tiers + Stripe billing
- [ ] Custom instance subdomains (paid)
- [ ] E2E encryption (X25519 + ChaCha20-Poly1305)
- [ ] Team accounts (multiple users, shared instances)
- [ ] Audit logging
- [ ] LiveDashboard admin panel

---

## Alternatives Considered

### Why not just use ngrok/Cloudflare Tunnel?

| Aspect               | ngrok/CF Tunnel        | TmuxDeck Cloud Relay      |
|-----------------------|------------------------|---------------------------|
| WebSocket support     | Works but not optimized| Purpose-built for WS      |
| Multiplexing          | New TCP conn per req   | Single WS, multiplexed    |
| Integration           | External tool          | Built into TmuxDeck       |
| Self-hostable         | No (ngrok) / complex   | `nixos-rebuild switch`    |
| UX                    | Separate config        | 2 env vars                |

### Why Elixir?

| Aspect                    | Node.js              | Go                   | Elixir/BEAM            |
|---------------------------|----------------------|----------------------|------------------------|
| Concurrent connections    | Event loop, single   | Goroutines           | Processes (~2KB each)  |
| Fault isolation           | Process crash = dead | Goroutine panic = ?  | Process crash = restart|
| Hot code reload           | Restart required     | Restart required     | Built-in OTP           |
| Binary protocol parsing   | Buffer gymnastics    | Good                 | Pattern matching       |
| Supervision/recovery      | PM2/external         | Manual               | OTP supervisors        |

---

## Security Considerations

1. **TLS everywhere**: Caddy handles automatic TLS with Let's Encrypt (including wildcard certs)
2. **Token hashing**: Instance tokens stored as Argon2 hashes, never plaintext
3. **Token shown once**: Raw token displayed only at creation time
4. **Revocation**: Tokens can be revoked instantly, blocking tunnel reconnection
5. **PIN auth preserved**: Relay never sees TmuxDeck PINs (pass-through)
6. **Tunnel isolation**: Each tunnel is a separate BEAM process - complete memory isolation
7. **Rate limiting**: Per-IP rate limits via ETS counters
8. **NixOS hardening**: systemd service runs with `DynamicUser`, `ProtectSystem=strict`, `NoNewPrivileges`
