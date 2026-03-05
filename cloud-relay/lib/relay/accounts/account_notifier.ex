defmodule Relay.Accounts.AccountNotifier do
  @moduledoc """
  Stub notifier - no email sending for MVP.
  Login uses password-based auth, not magic links.
  """

  require Logger

  def deliver_update_email_instructions(account, url) do
    Logger.info("Email update instructions for #{account.email}: #{url}")
    {:ok, :no_email}
  end

  def deliver_login_instructions(account, url) do
    Logger.info("Login instructions for #{account.email}: #{url}")
    {:ok, :no_email}
  end
end
