defmodule Relay.Application do
  @moduledoc false

  use Application

  @impl true
  def start(_type, _args) do
    children = [
      RelayWeb.Telemetry,
      Relay.Repo,
      {DNSCluster, query: Application.get_env(:relay, :dns_cluster_query) || :ignore},
      {Phoenix.PubSub, name: Relay.PubSub},
      {Registry, keys: :unique, name: Relay.TunnelRegistry},
      Relay.Tunnels.TunnelSupervisor,
      RelayWeb.Endpoint
    ]

    opts = [strategy: :one_for_one, name: Relay.Supervisor]
    Supervisor.start_link(children, opts)
  end

  @impl true
  def config_change(changed, _new, removed) do
    RelayWeb.Endpoint.config_change(changed, removed)
    :ok
  end
end
