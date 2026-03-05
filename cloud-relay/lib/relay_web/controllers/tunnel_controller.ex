defmodule RelayWeb.TunnelController do
  use RelayWeb, :controller

  def upgrade(conn, _params) do
    conn
    |> WebSockAdapter.upgrade(RelayWeb.TunnelSocket, %{authenticated: false, instance_id: nil, account_id: nil}, timeout: :infinity)
    |> halt()
  end
end
