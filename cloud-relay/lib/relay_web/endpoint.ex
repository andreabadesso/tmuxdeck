defmodule RelayWeb.Endpoint do
  use Phoenix.Endpoint, otp_app: :relay

  @session_options [
    store: :cookie,
    key: "_relay_key",
    signing_salt: "6haEPWkZ",
    same_site: "Lax"
  ]

  socket "/live", Phoenix.LiveView.Socket,
    websocket: [connect_info: [session: @session_options]],
    longpoll: [connect_info: [session: @session_options]]

  plug Plug.Static,
    at: "/",
    from: :relay,
    gzip: not code_reloading?,
    only: RelayWeb.static_paths(),
    raise_on_missing_only: code_reloading?

  if code_reloading? do
    socket "/phoenix/live_reload/socket", Phoenix.LiveReloader.Socket
    plug Phoenix.LiveReloader
    plug Phoenix.CodeReloader
    plug Phoenix.Ecto.CheckRepoStatus, otp_app: :relay
  end

  plug Phoenix.LiveDashboard.RequestLogger,
    param_key: "request_logger",
    cookie_key: "request_logger"

  plug Plug.RequestId
  plug Plug.Telemetry, event_prefix: [:phoenix, :endpoint]

  plug Plug.Parsers,
    parsers: [:urlencoded, :multipart, :json],
    pass: ["*/*"],
    json_decoder: Phoenix.json_library()

  plug Plug.MethodOverride
  plug Plug.Head
  plug :session_with_domain

  # Subdomain-based proxy (before router, so proxied requests bypass Phoenix routing)
  plug RelayWeb.Plugs.SubdomainPlug
  plug RelayWeb.Plugs.ProxyPlug

  plug RelayWeb.Router

  defp session_with_domain(conn, _opts) do
    host = __MODULE__.config(:url)[:host] || "localhost"

    opts =
      @session_options
      |> Keyword.put(:domain, ".#{host}")
      |> Plug.Session.init()

    Plug.Session.call(conn, opts)
  end
end
