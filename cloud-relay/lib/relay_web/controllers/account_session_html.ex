defmodule RelayWeb.AccountSessionHTML do
  use RelayWeb, :html

  embed_templates "account_session_html/*"

  defp local_mail_adapter? do
    Application.get_env(:relay, Relay.Mailer)[:adapter] == Swoosh.Adapters.Local
  end
end
