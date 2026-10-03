-- Ensure OAuth-created Supabase users receive a WiFi Voucher owner workspace.
-- The trigger function is defined by 006_google_oauth_profile.sql / schema.sql.
drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
after insert on auth.users
for each row execute procedure public.handle_new_user();
