defmodule RelayWeb.TunnelSocket do
  @moduledoc """
  Raw WebSocket handler for TmuxDeck instance tunnel connections.
  Uses WebSock directly instead of Phoenix Channels for binary frame performance.
  """
  @behaviour WebSock

  require Logger

  @impl WebSock
  def init(state) do
    # state is set by the upgrade in the endpoint
    {:ok, state}
  end

  @impl WebSock
  def handle_in({message, [opcode: :text]}, state) do
    case Jason.decode(message) do
      {:ok, %{"event" => "auth", "token" => token}} ->
        handle_auth(token, state)

      {:ok, %{"event" => "ping"}} ->
        {:push, {:text, Jason.encode!(%{"event" => "pong"})}, state}

      _ ->
        {:ok, state}
    end
  end

  def handle_in({data, [opcode: :binary]}, %{authenticated: true} = state) do
    case Relay.Tunnels.Protocol.decode_frame(data) do
      {:ok, stream_id, frame_type, payload} ->
        Relay.Tunnels.TunnelServer.agent_frame(
          state.instance_id,
          stream_id,
          frame_type,
          payload
        )

        {:ok, state}

      {:error, _} ->
        {:ok, state}
    end
  end

  def handle_in(_, state) do
    {:ok, state}
  end

  @impl WebSock
  def handle_info({:send_frame, frame}, state) do
    {:push, {:binary, frame}, state}
  end

  def handle_info(:tunnel_closed, state) do
    {:stop, :normal, state}
  end

  def handle_info(_, state) do
    {:ok, state}
  end

  @impl WebSock
  def terminate(_reason, %{authenticated: true} = state) do
    Logger.info("Tunnel disconnected: #{state.instance_id}")
    instance = Relay.Instances.get_instance_by_instance_id(state.instance_id)
    if instance, do: Relay.Instances.mark_offline(instance)
    :ok
  end

  def terminate(_reason, _state), do: :ok

  defp handle_auth(token, state) do
    case Relay.Instances.verify_token(token) do
      {:ok, instance} ->
        case Relay.Tunnels.TunnelSupervisor.start_tunnel(
               instance_id: instance.instance_id,
               account_id: instance.account_id,
               agent_pid: self()
             ) do
          {:ok, _pid} ->
            Relay.Instances.mark_online(instance)

            reply =
              Jason.encode!(%{
                "event" => "authenticated",
                "instance_id" => instance.instance_id,
                "url" => RelayWeb.Endpoint.url() |> build_instance_url(instance.instance_id)
              })

            new_state = %{
              state
              | authenticated: true,
                instance_id: instance.instance_id,
                account_id: instance.account_id
            }

            {:push, {:text, reply}, new_state}

          {:error, {:already_started, _}} ->
            reply = Jason.encode!(%{"event" => "error", "reason" => "instance_already_connected"})
            {:push, {:text, reply}, state}
        end

      {:error, reason} ->
        reply = Jason.encode!(%{"event" => "error", "reason" => to_string(reason)})
        {:push, {:text, reply}, state}
    end
  end

  defp build_instance_url(base_url, instance_id) do
    uri = URI.parse(base_url)
    # Insert instance_id as subdomain
    %{uri | host: "#{instance_id}.#{uri.host}"} |> URI.to_string()
  end
end
