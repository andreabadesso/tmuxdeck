defmodule RelayWeb.InstanceNewLive do
  use RelayWeb, :live_view

  alias Relay.Instances

  @impl true
  def mount(_params, _session, socket) do
    {:ok, assign(socket, token: nil, instance: nil, name: "", error: nil, page_title: "New Instance")}
  end

  @impl true
  def handle_event("create", %{"name" => name}, socket) do
    account = socket.assigns.current_scope.account

    case Instances.create(account, name) do
      {:ok, instance, raw_token} ->
        {:noreply, assign(socket, instance: instance, token: raw_token, error: nil)}

      {:error, changeset} ->
        error =
          changeset
          |> Ecto.Changeset.traverse_errors(fn {msg, _} -> msg end)
          |> Enum.map_join(", ", fn {field, msgs} -> "#{field}: #{Enum.join(msgs, ", ")}" end)

        {:noreply, assign(socket, error: error)}
    end
  end

  @impl true
  def render(assigns) do
    ~H"""
    <div class="max-w-2xl mx-auto">
      <.link navigate={~p"/dashboard"} class="text-sm text-zinc-400 hover:text-zinc-300 mb-4 inline-block">
        &larr; Back to Dashboard
      </.link>

      <div :if={@token} class="bg-zinc-800 rounded-lg p-8 border border-zinc-700">
        <h2 class="text-xl font-bold text-green-400 mb-4">Instance Created</h2>

        <div class="bg-yellow-900/30 border border-yellow-700 rounded p-4 mb-6">
          <p class="text-yellow-300 text-sm font-medium">
            Copy these values now. The token will not be shown again.
          </p>
        </div>

        <div class="bg-zinc-900 rounded p-4 font-mono text-sm space-y-2">
          <div class="flex items-center justify-between">
            <span class="text-zinc-400">RELAY_URL=</span>
            <span class="text-green-300">wss://<%= RelayWeb.Endpoint.config(:url)[:host] || "relay.tmuxdeck.io" %>/ws/tunnel</span>
          </div>
          <div class="flex items-center justify-between">
            <span class="text-zinc-400">RELAY_TOKEN=</span>
            <span class="text-green-300 break-all"><%= @token %></span>
          </div>
        </div>

        <p class="text-sm text-zinc-400 mt-6">
          Add these to your TmuxDeck <code class="bg-zinc-700 px-1 rounded">.env</code> file or Docker Compose environment.
        </p>

        <.link navigate={~p"/dashboard"} class="mt-6 inline-block bg-blue-600 hover:bg-blue-700 text-white px-4 py-2 rounded-lg transition">
          Back to Dashboard
        </.link>
      </div>

      <div :if={!@token} class="bg-zinc-800 rounded-lg p-8 border border-zinc-700">
        <h2 class="text-xl font-bold mb-6">Create New Instance</h2>

        <div :if={@error} class="bg-red-900/30 border border-red-700 rounded p-3 mb-4">
          <p class="text-red-300 text-sm"><%= @error %></p>
        </div>

        <form phx-submit="create" class="space-y-4">
          <div>
            <label for="name" class="block text-sm font-medium text-zinc-300 mb-1">
              Instance Name
            </label>
            <input
              type="text"
              name="name"
              id="name"
              value={@name}
              placeholder="e.g. homelab, work-server"
              required
              class="w-full bg-zinc-900 border border-zinc-600 rounded-lg px-4 py-2 text-white placeholder-zinc-500 focus:outline-none focus:border-blue-500"
            />
          </div>

          <button type="submit" class="bg-blue-600 hover:bg-blue-700 text-white px-6 py-2 rounded-lg transition">
            Create Instance
          </button>
        </form>
      </div>
    </div>
    """
  end
end
