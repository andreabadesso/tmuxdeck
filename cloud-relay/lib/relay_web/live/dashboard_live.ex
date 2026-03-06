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
    <div style="max-width: 56rem; margin: 0 auto;">

      <%# Page header %>
      <div style="display: flex; align-items: center; justify-content: space-between; margin-bottom: 2rem;">
        <div>
          <div style="font-family: var(--mono); font-size: 0.7rem; color: var(--muted); letter-spacing: 0.1em; text-transform: uppercase; margin-bottom: 4px;">
            Dashboard
          </div>
          <h1 style="font-size: 1.5rem; font-weight: 600; color: var(--text); letter-spacing: -0.03em; margin: 0;">
            My Instances
          </h1>
        </div>
        <.link navigate={~p"/instances/new"}
          style="background: var(--accent); color: #0c0c0e; font-size: 0.875rem; font-weight: 600;
                 text-decoration: none; padding: 8px 16px; border-radius: 7px; display: flex;
                 align-items: center; gap: 6px; transition: opacity 0.15s;">
          <span style="font-size: 1.1em; line-height: 1;">+</span>
          New Instance
        </.link>
      </div>

      <%# Empty state %>
      <div :if={@instances == []} style="text-align: center; padding: 5rem 2rem;">
        <div style="font-family: var(--mono); font-size: 2rem; color: var(--border); margin-bottom: 1rem;">
          [ ]
        </div>
        <p style="color: var(--text); font-weight: 500; margin: 0 0 0.5rem;">No instances yet</p>
        <p style="color: var(--muted); font-size: 0.875rem; margin: 0 0 1.5rem;">
          Create one to connect your TmuxDeck server.
        </p>
        <.link navigate={~p"/instances/new"}
          style="background: var(--surface-2); border: 1px solid var(--border); color: var(--text);
                 font-size: 0.875rem; text-decoration: none; padding: 8px 20px; border-radius: 7px;">
          Create your first instance →
        </.link>
      </div>

      <%# Instance list %>
      <div style="display: flex; flex-direction: column; gap: 1px; border-radius: 10px; overflow: hidden; border: 1px solid var(--border);">
        <div :for={instance <- @instances}
          style="background: var(--surface); padding: 1.25rem 1.5rem; transition: background 0.1s;"
          onmouseover="this.style.background='var(--surface-2)'"
          onmouseout="this.style.background='var(--surface)'">
          <div style="display: flex; align-items: center; justify-content: space-between; gap: 1rem;">
            <div style="min-width: 0; flex: 1;">
              <div style="display: flex; align-items: center; gap: 0.75rem; margin-bottom: 0.35rem; flex-wrap: wrap;">
                <h2 style="font-size: 1rem; font-weight: 600; color: var(--text); margin: 0;">
                  <%= instance.name %>
                </h2>
                <span class={if instance.status == "online", do: "status-online", else: "status-offline"}>
                  <%= instance.status %>
                </span>
              </div>
              <p style="font-family: var(--mono); font-size: 0.75rem; color: var(--muted); margin: 0 0 0.2rem; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;">
                <%= instance.instance_id %>.relay.tmuxdeck.io
              </p>
              <p :if={instance.last_seen_at} style="font-family: var(--mono); font-size: 0.7rem; color: var(--border-hover); margin: 0;">
                last seen <%= Calendar.strftime(instance.last_seen_at, "%Y-%m-%d %H:%M UTC") %>
              </p>
            </div>

            <div style="display: flex; align-items: center; gap: 0.5rem; flex-shrink: 0;">
              <.link
                navigate={~p"/instances/#{instance.id}"}
                style="font-size: 0.8rem; font-family: var(--mono); color: var(--accent);
                       text-decoration: none; padding: 5px 12px; border-radius: 6px;
                       border: 1px solid rgba(249,115,22,0.2); background: var(--accent-dim);
                       transition: border-color 0.15s;"
                onmouseover="this.style.borderColor='var(--accent)'"
                onmouseout="this.style.borderColor='rgba(249,115,22,0.2)'">
                Details
              </.link>
              <button
                phx-click="delete"
                phx-value-id={instance.id}
                data-confirm="Are you sure? This will disconnect the instance."
                style="font-size: 0.8rem; font-family: var(--mono); color: var(--muted);
                       background: transparent; border: 1px solid var(--border);
                       padding: 5px 12px; border-radius: 6px; cursor: pointer;
                       transition: color 0.15s, border-color 0.15s;"
                onmouseover="this.style.color='#f87171'; this.style.borderColor='rgba(248,113,113,0.3)'"
                onmouseout="this.style.color='var(--muted)'; this.style.borderColor='var(--border)'">
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
