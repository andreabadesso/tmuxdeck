defmodule RelayWeb.Plugs.SubdomainPlug do
  @moduledoc """
  Extracts the instance_id from the subdomain of the request.
  For example, "abc123.relay.tmuxdeck.io" extracts "abc123".
  """
  import Plug.Conn

  def init(opts), do: opts

  def call(conn, _opts) do
    base_host = RelayWeb.Endpoint.config(:url)[:host] || "localhost"

    case extract_subdomain(conn.host, base_host) do
      nil ->
        conn

      subdomain ->
        assign(conn, :instance_id, subdomain)
    end
  end

  defp extract_subdomain(host, base_host) do
    host = String.downcase(host)
    base = String.downcase(base_host)

    cond do
      host == base ->
        nil

      String.ends_with?(host, "." <> base) ->
        host
        |> String.replace_suffix("." <> base, "")
        |> case do
          "" -> nil
          subdomain -> subdomain
        end

      true ->
        nil
    end
  end
end
