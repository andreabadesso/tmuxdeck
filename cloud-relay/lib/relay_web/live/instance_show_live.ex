defmodule RelayWeb.InstanceShowLive do
  use RelayWeb, :live_view

  alias Relay.Instances

  @impl true
  def mount(%{"id" => id}, _session, socket) do
    account = socket.assigns.current_scope.account
    instance = Instances.get_instance!(id)

    # Verify ownership
    if instance.account_id != account.id do
      {:ok, push_navigate(socket, to: ~p"/dashboard")}
    else
      if connected?(socket) do
        Phoenix.PubSub.subscribe(Relay.PubSub, "account:#{account.id}")
      end

      {:ok,
       assign(socket,
         instance: instance,
         new_token: nil,
         page_title: instance.name
       )}
    end
  end

  @impl true
  def handle_info({:instance_status, instance_id, status}, socket) do
    if socket.assigns.instance.id == instance_id do
      instance = %{socket.assigns.instance | status: status}
      {:noreply, assign(socket, instance: instance)}
    else
      {:noreply, socket}
    end
  end

  @impl true
  def handle_event("revoke", _, socket) do
    {:ok, instance} = Instances.revoke_token(socket.assigns.instance)
    {:noreply, assign(socket, instance: instance)}
  end

  def handle_event("regenerate", _, socket) do
    case Instances.regenerate_token(socket.assigns.instance) do
      {:ok, instance, raw_token} ->
        {:noreply, assign(socket, instance: instance, new_token: raw_token)}

      {:error, _} ->
        {:noreply, socket}
    end
  end

  @impl true
  def render(assigns) do
    ~H"""
    <div class="max-w-2xl mx-auto">
      <.link navigate={~p"/dashboard"} class="text-sm text-zinc-400 hover:text-zinc-300 mb-4 inline-block">
        &larr; Back to Dashboard
      </.link>

      <div class="bg-zinc-800 rounded-lg p-8 border border-zinc-700">
        <div class="flex items-center justify-between mb-6">
          <h2 class="text-xl font-bold"><%= @instance.name %></h2>
          <span
            class={[
              "inline-flex items-center px-2 py-0.5 rounded text-xs font-medium",
              @instance.status == "online" && "bg-green-900 text-green-300",
              @instance.status == "offline" && "bg-zinc-700 text-zinc-400"
            ]}
          >
            <%= @instance.status %>
          </span>
        </div>

        <dl class="space-y-4">
          <div>
            <dt class="text-sm text-zinc-400">Instance ID</dt>
            <dd class="font-mono text-sm"><%= @instance.instance_id %></dd>
          </div>
          <div>
            <dt class="text-sm text-zinc-400">Public URL</dt>
            <dd class="font-mono text-sm text-blue-400">
              https://<%= @instance.instance_id %>.<%= RelayWeb.Endpoint.config(:url)[:host] || "relay.tmuxdeck.io" %>
            </dd>
          </div>
          <div>
            <dt class="text-sm text-zinc-400">Token Status</dt>
            <dd class="text-sm">
              <%= if @instance.revoked_at do %>
                <span class="text-red-400">Revoked at <%= Calendar.strftime(@instance.revoked_at, "%Y-%m-%d %H:%M UTC") %></span>
              <% else %>
                <span class="text-green-400">Active</span>
                <span class="text-zinc-500 ml-2">(prefix: <%= @instance.token_prefix %>)</span>
              <% end %>
            </dd>
          </div>
          <div :if={@instance.last_seen_at}>
            <dt class="text-sm text-zinc-400">Last Seen</dt>
            <dd class="text-sm"><%= Calendar.strftime(@instance.last_seen_at, "%Y-%m-%d %H:%M:%S UTC") %></dd>
          </div>
          <div>
            <dt class="text-sm text-zinc-400">Created</dt>
            <dd class="text-sm"><%= Calendar.strftime(@instance.inserted_at, "%Y-%m-%d %H:%M UTC") %></dd>
          </div>
        </dl>

        <div :if={@new_token} class="mt-6 bg-yellow-900/30 border border-yellow-700 rounded p-4">
          <p class="text-yellow-300 text-sm font-medium mb-2">New token (copy now, shown once):</p>
          <code class="text-green-300 break-all text-sm"><%= @new_token %></code>
        </div>

        <div class="mt-8 flex gap-3">
          <button
            :if={!@instance.revoked_at}
            phx-click="revoke"
            data-confirm="Revoke this token? The instance will disconnect."
            class="bg-yellow-700 hover:bg-yellow-600 text-white px-4 py-2 rounded-lg text-sm transition"
          >
            Revoke Token
          </button>
          <button
            phx-click="regenerate"
            data-confirm="Generate a new token? The old one will stop working."
            class="bg-blue-600 hover:bg-blue-700 text-white px-4 py-2 rounded-lg text-sm transition"
          >
            Regenerate Token
          </button>
        </div>
      </div>
    </div>
    """
  end
end
