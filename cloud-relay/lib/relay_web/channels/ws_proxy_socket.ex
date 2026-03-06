defmodule RelayWeb.WsProxySocket do
  @moduledoc """
  Proxies WebSocket connections through the tunnel to TmuxDeck backends.
  Used for terminal connections (xterm.js -> relay -> TmuxDeck backend).
  """
  @behaviour WebSock

  require Logger

  @impl WebSock
  def init(%{tunnel_pid: tunnel_pid, path: path} = state) when is_pid(tunnel_pid) do
    {:ok, stream_id} = Relay.Tunnels.TunnelServer.open_stream(tunnel_pid, self())

    ws_open_payload = Jason.encode!(%{"path" => path, "headers" => Map.get(state, :headers, %{})})

    Relay.Tunnels.TunnelServer.client_frame(
      tunnel_pid,
      stream_id,
      :ws_open,
      ws_open_payload
    )

    {:ok, %{state | stream_id: stream_id}}
  end

  def init(%{instance_id: instance_id, path: path} = state) do
    case Relay.Tunnels.TunnelServer.lookup(instance_id) do
      {:ok, tunnel_pid} ->
        {:ok, stream_id} = Relay.Tunnels.TunnelServer.open_stream(tunnel_pid, self())

        ws_open_payload = Jason.encode!(%{"path" => path, "headers" => Map.get(state, :headers, %{})})

        Relay.Tunnels.TunnelServer.client_frame(
          tunnel_pid,
          stream_id,
          :ws_open,
          ws_open_payload
        )

        {:ok, %{state | tunnel_pid: tunnel_pid, stream_id: stream_id}}

      :not_found ->
        {:stop, :normal, state}
    end
  end

  @impl WebSock
  def handle_in({message, [opcode: :text]}, state) do
    Relay.Tunnels.TunnelServer.client_frame(
      state.tunnel_pid,
      state.stream_id,
      :ws_data,
      message
    )

    {:ok, state}
  end

  def handle_in({data, [opcode: :binary]}, state) do
    Relay.Tunnels.TunnelServer.client_frame(
      state.tunnel_pid,
      state.stream_id,
      :ws_data,
      data
    )

    {:ok, state}
  end

  @impl WebSock
  def handle_info({:tunnel_frame, _stream_id, :ws_data, payload}, state) do
    # Detect if payload is likely text or binary
    if String.valid?(payload) do
      {:push, {:text, payload}, state}
    else
      {:push, {:binary, payload}, state}
    end
  end

  def handle_info({:tunnel_frame, _stream_id, :ws_close, _payload}, state) do
    {:stop, :normal, state}
  end

  def handle_info(:tunnel_closed, state) do
    {:stop, :normal, state}
  end

  def handle_info(_, state) do
    {:ok, state}
  end

  @impl WebSock
  def terminate(_reason, %{tunnel_pid: tunnel_pid, stream_id: stream_id}) do
    Relay.Tunnels.TunnelServer.close_stream(tunnel_pid, stream_id)
    :ok
  end

  def terminate(_reason, _state), do: :ok
end
