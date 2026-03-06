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
    <div style="max-width: 42rem; margin: 0 auto;">
      <.link navigate={~p"/dashboard"}
        style="font-family: var(--mono); font-size: 0.75rem; color: var(--muted); text-decoration: none;
               display: inline-flex; align-items: center; gap: 6px; margin-bottom: 1.5rem;"
        onmouseover="this.style.color='var(--text)'" onmouseout="this.style.color='var(--muted)'">
        ← Back to Dashboard
      </.link>

      <div class="card" style="padding: 2rem;">
        <div style="display: flex; align-items: center; justify-content: space-between; margin-bottom: 2rem;">
          <h2 style="font-size: 1.25rem; font-weight: 600; color: var(--text); margin: 0;">
            <%= @instance.name %>
          </h2>
          <span class={if @instance.status == "online", do: "status-online", else: "status-offline"}>
            <%= @instance.status %>
          </span>
        </div>

        <dl style="display: flex; flex-direction: column; gap: 1.25rem;">
          <div>
            <dt style="font-family: var(--mono); font-size: 0.65rem; color: var(--muted); letter-spacing: 0.1em; text-transform: uppercase; margin-bottom: 4px;">Instance ID</dt>
            <dd style="font-family: var(--mono); font-size: 0.85rem; color: var(--text); margin: 0;"><%= @instance.instance_id %></dd>
          </div>
          <div>
            <dt style="font-family: var(--mono); font-size: 0.65rem; color: var(--muted); letter-spacing: 0.1em; text-transform: uppercase; margin-bottom: 4px;">Public URL</dt>
            <dd style="margin: 0;">
              <a href={"https://#{@instance.instance_id}.#{RelayWeb.Endpoint.config(:url)[:host] || "relay.tmuxdeck.io"}"}
                target="_blank"
                style="font-family: var(--mono); font-size: 0.85rem; color: var(--accent); text-decoration: none; word-break: break-all;"
                onmouseover="this.style.textDecoration='underline'"
                onmouseout="this.style.textDecoration='none'">
                https://<%= @instance.instance_id %>.<%= RelayWeb.Endpoint.config(:url)[:host] || "relay.tmuxdeck.io" %>
              </a>
            </dd>
          </div>
          <div>
            <dt style="font-family: var(--mono); font-size: 0.65rem; color: var(--muted); letter-spacing: 0.1em; text-transform: uppercase; margin-bottom: 4px;">Token Status</dt>
            <dd style="font-family: var(--mono); font-size: 0.85rem; margin: 0;">
              <%= if @instance.revoked_at do %>
                <span style="color: #f87171;">revoked · <%= Calendar.strftime(@instance.revoked_at, "%Y-%m-%d %H:%M UTC") %></span>
              <% else %>
                <span style="color: #4ade80;">active</span>
                <span style="color: var(--muted); margin-left: 0.75rem; font-size: 0.75rem;">prefix: <%= @instance.token_prefix %></span>
              <% end %>
            </dd>
          </div>
          <div :if={@instance.last_seen_at}>
            <dt style="font-family: var(--mono); font-size: 0.65rem; color: var(--muted); letter-spacing: 0.1em; text-transform: uppercase; margin-bottom: 4px;">Last Seen</dt>
            <dd style="font-family: var(--mono); font-size: 0.85rem; color: var(--text); margin: 0;"><%= Calendar.strftime(@instance.last_seen_at, "%Y-%m-%d %H:%M:%S UTC") %></dd>
          </div>
          <div>
            <dt style="font-family: var(--mono); font-size: 0.65rem; color: var(--muted); letter-spacing: 0.1em; text-transform: uppercase; margin-bottom: 4px;">Created</dt>
            <dd style="font-family: var(--mono); font-size: 0.85rem; color: var(--text); margin: 0;"><%= Calendar.strftime(@instance.inserted_at, "%Y-%m-%d %H:%M UTC") %></dd>
          </div>
        </dl>

        <div :if={@new_token} style="margin-top: 1.5rem; background: rgba(74,222,128,0.05); border: 1px solid rgba(74,222,128,0.2); border-radius: 8px; padding: 1rem;">
          <p style="font-family: var(--mono); font-size: 0.7rem; color: #4ade80; letter-spacing: 0.08em; text-transform: uppercase; margin: 0 0 8px;">
            New token — copy now, shown once
          </p>
          <code style="font-family: var(--mono); font-size: 0.8rem; color: #4ade80; word-break: break-all;"><%= @new_token %></code>
        </div>

        <div style="margin-top: 2rem; display: flex; gap: 0.75rem;">
          <button
            :if={!@instance.revoked_at}
            phx-click="revoke"
            data-confirm="Revoke this token? The instance will disconnect."
            style="font-family: var(--mono); font-size: 0.8rem; color: #fbbf24; background: rgba(251,191,36,0.08);
                   border: 1px solid rgba(251,191,36,0.2); padding: 8px 16px; border-radius: 7px; cursor: pointer;
                   transition: border-color 0.15s;"
            onmouseover="this.style.borderColor='rgba(251,191,36,0.5)'"
            onmouseout="this.style.borderColor='rgba(251,191,36,0.2)'">
            Revoke Token
          </button>
          <button
            phx-click="regenerate"
            data-confirm="Generate a new token? The old one will stop working."
            class="btn-accent"
            style="font-family: var(--mono); font-size: 0.8rem; padding: 8px 16px; border-radius: 7px; cursor: pointer;">
            Regenerate Token
          </button>
        </div>
      </div>
    </div>
    """
  end
end
