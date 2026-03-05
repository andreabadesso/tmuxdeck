defmodule RelayWeb.DashboardLive do
  use RelayWeb, :live_view

  alias Relay.Instances

  @impl true
  def mount(_params, _session, socket) do
    account = socket.assigns.current_scope.account

    if connected?(socket) do
      Phoenix.PubSub.subscribe(Relay.PubSub, "account:#{account.id}")
    end

    instances = Instances.list_instances(account.id)

    {:ok, assign(socket, instances: instances, page_title: "Dashboard")}
  end

  @impl true
  def handle_info({:instance_status, instance_id, status}, socket) do
    instances =
      Enum.map(socket.assigns.instances, fn inst ->
        if inst.id == instance_id, do: %{inst | status: status}, else: inst
      end)

    {:noreply, assign(socket, instances: instances)}
  end

  @impl true
  def handle_event("delete", %{"id" => id}, socket) do
    instance = Instances.get_instance!(id)
    {:ok, _} = Instances.delete_instance(instance)
    instances = Enum.reject(socket.assigns.instances, &(&1.id == id))
    {:noreply, assign(socket, instances: instances)}
  end

  @impl true
  def render(assigns) do
    ~H"""
    <div class="max-w-4xl mx-auto">
      <div class="flex items-center justify-between mb-8">
        <h1 class="text-2xl font-bold">My Instances</h1>
        <.link navigate={~p"/instances/new"} class="bg-blue-600 hover:bg-blue-700 text-white px-4 py-2 rounded-lg transition">
          + New Instance
        </.link>
      </div>

      <div :if={@instances == []} class="text-center py-16 text-zinc-400">
        <p class="text-lg">No instances yet.</p>
        <p class="mt-2">Create one to connect your TmuxDeck server.</p>
      </div>

      <div class="space-y-4">
        <div :for={instance <- @instances} class="bg-zinc-800 rounded-lg p-6 border border-zinc-700">
          <div class="flex items-center justify-between">
            <div>
              <div class="flex items-center gap-3">
                <h2 class="text-lg font-semibold"><%= instance.name %></h2>
                <span
                  class={[
                    "inline-flex items-center px-2 py-0.5 rounded text-xs font-medium",
                    instance.status == "online" && "bg-green-900 text-green-300",
                    instance.status == "offline" && "bg-zinc-700 text-zinc-400"
                  ]}
                >
                  <%= instance.status %>
                </span>
              </div>
              <p class="text-sm text-zinc-400 mt-1 font-mono">
                <%= instance.instance_id %>.relay.tmuxdeck.io
              </p>
              <p :if={instance.last_seen_at} class="text-xs text-zinc-500 mt-1">
                Last seen: <%= Calendar.strftime(instance.last_seen_at, "%Y-%m-%d %H:%M UTC") %>
              </p>
            </div>

            <div class="flex items-center gap-2">
              <.link
                navigate={~p"/instances/#{instance.id}"}
                class="text-sm text-blue-400 hover:text-blue-300"
              >
                Details
              </.link>
              <button
                phx-click="delete"
                phx-value-id={instance.id}
                data-confirm="Are you sure? This will disconnect the instance."
                class="text-sm text-red-400 hover:text-red-300"
              >
                Delete
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
    """
  end
end
