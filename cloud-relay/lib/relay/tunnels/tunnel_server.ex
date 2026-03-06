defmodule Relay.Tunnels.TunnelServer do
  @moduledoc """
  GenServer managing a single active tunnel for a TmuxDeck instance.
  Each connected instance gets one TunnelServer process.
  """
  use GenServer
  require Logger

  defstruct [
    :instance_id,
    :account_id,
    :agent_pid,
    :agent_monitor,
    streams: %{},
    next_stream_id: 1,
    connected_at: nil
  ]

  def start_link(opts) do
    instance_id = Keyword.fetch!(opts, :instance_id)
    GenServer.start_link(__MODULE__, opts, name: via(instance_id))
  end

  def via(instance_id) do
    {:via, Registry, {Relay.TunnelRegistry, instance_id}}
  end

  def lookup(instance_id) do
    case Registry.lookup(Relay.TunnelRegistry, instance_id) do
      [{pid, _}] -> {:ok, pid}
      [] -> :not_found
    end
  end

  def open_stream(tunnel_pid, client_pid) do
    GenServer.call(tunnel_pid, {:open_stream, client_pid})
  end

  def close_stream(tunnel_pid, stream_id) do
    GenServer.cast(tunnel_pid, {:close_stream, stream_id})
  end

  def client_frame(tunnel_pid, stream_id, frame_type, payload) do
    GenServer.cast(tunnel_pid, {:client_frame, stream_id, frame_type, payload})
  end

  def agent_frame(instance_id, stream_id, frame_type, payload) do
    case lookup(instance_id) do
      {:ok, pid} -> GenServer.cast(pid, {:agent_frame, stream_id, frame_type, payload})
      :not_found -> :ok
    end
  end

  # Server callbacks

  @impl true
  def init(opts) do
    instance_id = Keyword.fetch!(opts, :instance_id)
    account_id = Keyword.fetch!(opts, :account_id)
    agent_pid = Keyword.fetch!(opts, :agent_pid)

    ref = Process.monitor(agent_pid)

    Logger.info("Tunnel started for instance #{instance_id}")

    {:ok,
     %__MODULE__{
       instance_id: instance_id,
       account_id: account_id,
       agent_pid: agent_pid,
       agent_monitor: ref,
       connected_at: DateTime.utc_now(:second)
     }}
  end

  @impl true
  def handle_call({:open_stream, client_pid}, _from, state) do
    stream_id = state.next_stream_id
    Process.monitor(client_pid)
    streams = Map.put(state.streams, stream_id, client_pid)

    {:reply, {:ok, stream_id},
     %{state | streams: streams, next_stream_id: stream_id + 1}}
  end

  @impl true
  def handle_cast({:close_stream, stream_id}, state) do
    {:noreply, %{state | streams: Map.delete(state.streams, stream_id)}}
  end

  def handle_cast({:agent_frame, stream_id, frame_type, payload}, state) do
    case Map.get(state.streams, stream_id) do
      nil -> :ok
      client_pid -> send(client_pid, {:tunnel_frame, stream_id, frame_type, payload})
    end

    {:noreply, state}
  end

  def handle_cast({:client_frame, stream_id, frame_type, payload}, state) do
    frame = Relay.Tunnels.Protocol.encode_frame(stream_id, frame_type, payload)
    send(state.agent_pid, {:send_frame, frame})
    {:noreply, state}
  end

  @impl true
  def handle_info({:DOWN, ref, :process, _, _reason}, %{agent_monitor: ref} = state) do
    Logger.info("Agent disconnected for instance #{state.instance_id}")

    for {_stream_id, client_pid} <- state.streams do
      send(client_pid, :tunnel_closed)
    end

    {:stop, :normal, state}
  end

  def handle_info({:DOWN, _ref, :process, pid, _reason}, state) do
    # A client stream process went down - clean up its stream
    streams =
      state.streams
      |> Enum.reject(fn {_id, p} -> p == pid end)
      |> Map.new()

    {:noreply, %{state | streams: streams}}
  end

  @impl true
  def terminate(_reason, state) do
    for {_stream_id, client_pid} <- state.streams do
      send(client_pid, :tunnel_closed)
    end

    :ok
  end
end
