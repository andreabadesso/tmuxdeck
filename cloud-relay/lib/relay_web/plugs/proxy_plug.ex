defmodule RelayWeb.Plugs.ProxyPlug do
  @moduledoc """
  Proxies HTTP requests through the tunnel to the TmuxDeck backend.
  Only active when an instance_id is assigned by SubdomainPlug.
  """
  import Plug.Conn

  @proxy_timeout 30_000

  def init(opts), do: opts

  def call(%{assigns: %{instance_id: instance_id}} = conn, _opts) when is_binary(instance_id) do
    proxy_request(conn, instance_id)
  end

  def call(conn, _opts), do: conn

  defp proxy_request(conn, instance_id) do
    case Relay.Tunnels.TunnelServer.lookup(instance_id) do
      :not_found ->
        conn
        |> put_resp_content_type("text/plain")
        |> send_resp(502, "Instance offline")
        |> halt()

      {:ok, tunnel_pid} ->
        # Check if this is a WebSocket upgrade
        if websocket_upgrade?(conn) do
          proxy_websocket(conn, tunnel_pid, instance_id)
        else
          proxy_http(conn, tunnel_pid)
        end
    end
  end

  defp proxy_http(conn, tunnel_pid) do
    # Plug.Parsers runs before this plug and consumes the raw body.
    # If read_body returns empty, re-encode body_params as JSON fallback.
    {:ok, raw, conn} = read_body(conn)
    body =
      if raw == "" and map_size(conn.body_params) > 0 do
        Jason.encode!(conn.body_params)
      else
        raw
      end
    {:ok, stream_id} = Relay.Tunnels.TunnelServer.open_stream(tunnel_pid, self())

    request_payload =
      Relay.Tunnels.Protocol.encode_http_request(
        conn.method,
        request_path_with_query(conn),
        filter_headers(conn.req_headers),
        body
      )

    Relay.Tunnels.TunnelServer.client_frame(tunnel_pid, stream_id, :http_request, request_payload)

    receive do
      {:tunnel_frame, ^stream_id, :http_response, payload} ->
        Relay.Tunnels.TunnelServer.close_stream(tunnel_pid, stream_id)

        case Relay.Tunnels.Protocol.decode_http_response(payload) do
          {:ok, status, headers, response_body} ->
            conn
            |> apply_resp_headers(filter_response_headers(headers))
            |> send_resp(status, response_body)
            |> halt()

          {:error, _} ->
            conn |> send_resp(502, "Invalid response from instance") |> halt()
        end

      :tunnel_closed ->
        conn |> send_resp(502, "Instance disconnected") |> halt()
    after
      @proxy_timeout ->
        Relay.Tunnels.TunnelServer.close_stream(tunnel_pid, stream_id)
        conn |> send_resp(504, "Tunnel timeout") |> halt()
    end
  end

  defp proxy_websocket(conn, tunnel_pid, instance_id) do
    path = request_path_with_query(conn)
    headers = filter_headers(conn.req_headers)

    state = %{
      instance_id: instance_id,
      path: path,
      headers: headers,
      tunnel_pid: tunnel_pid,
      stream_id: nil
    }

    WebSockAdapter.upgrade(conn, RelayWeb.WsProxySocket, state, [])
    |> halt()
  end

  defp websocket_upgrade?(conn) do
    upgrade_header =
      conn
      |> get_req_header("upgrade")
      |> List.first()
      |> Kernel.||("")
      |> String.downcase()

    upgrade_header == "websocket"
  end

  defp request_path_with_query(%{request_path: path, query_string: ""}), do: path
  defp request_path_with_query(%{request_path: path, query_string: qs}), do: "#{path}?#{qs}"

  defp filter_headers(headers) do
    headers
    |> Enum.reject(fn {key, _} ->
      key in ["host", "transfer-encoding", "connection", "upgrade"]
    end)
    |> Map.new()
  end

  defp filter_response_headers(headers) when is_map(headers) do
    headers
    |> Enum.reject(fn {key, _} ->
      String.downcase(key) in ["transfer-encoding", "connection"]
    end)
  end

  defp filter_response_headers(headers) when is_list(headers), do: filter_response_headers(Map.new(headers))

  defp apply_resp_headers(conn, headers) do
    Enum.reduce(headers, conn, fn {key, value}, conn ->
      put_resp_header(conn, String.downcase(key), value)
    end)
  end
end
