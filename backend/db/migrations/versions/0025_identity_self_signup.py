"""Allow identity authority to atomically create an empty private workspace."""
from alembic import op

revision = "0025_identity_self_signup"
down_revision = "0024_statement_staging"
branch_labels = None
depends_on = None


def upgrade():
    # Include disabled identities: they must never appear to be new members.
    op.execute("CREATE INDEX identity_subject_all ON moneylens.users (subject_issuer,subject_id)")
    op.execute("""CREATE FUNCTION moneylens_identity.ensure_workspace(p_issuer text, p_subject text)
        RETURNS TABLE (tenant_id uuid, id uuid, permission_version bigint, active boolean, is_synthetic boolean)
        LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
        DECLARE
            member_count integer;
            member moneylens.users%ROWTYPE;
            new_tenant uuid;
            new_member uuid;
        BEGIN
            IF p_issuer IS NULL OR p_issuer NOT LIKE 'https://%'
                OR p_subject IS NULL OR length(p_subject) NOT BETWEEN 1 AND 255
                OR current_setting('transaction_isolation') <> 'read committed' THEN
                RETURN;
            END IF;
            -- This matches administrator provisioning and also excludes manual
            -- user INSERT/UPDATE/DELETE races. Keep this transaction short.
            LOCK TABLE moneylens.users IN SHARE ROW EXCLUSIVE MODE;
            SELECT count(*) INTO member_count FROM (
                SELECT 1 FROM moneylens.users u
                WHERE u.subject_issuer=p_issuer AND u.subject_id=p_subject LIMIT 2
            ) found;
            IF member_count > 1 THEN RETURN; END IF;
            IF member_count = 1 THEN
                SELECT u.* INTO member FROM moneylens.users u
                WHERE u.subject_issuer=p_issuer AND u.subject_id=p_subject;
                IF NOT member.active OR member.is_synthetic OR NOT EXISTS (
                    SELECT 1 FROM moneylens.user_state s
                    WHERE s.tenant_id=member.tenant_id AND s.owner_user_id=member.id
                ) THEN RETURN; END IF;
                RETURN QUERY SELECT member.tenant_id,member.id,member.permission_version,member.active,member.is_synthetic;
                RETURN;
            END IF;
            new_tenant := gen_random_uuid();
            new_member := gen_random_uuid();
            INSERT INTO moneylens.tenants (id,name) VALUES (new_tenant,'Money Coach private');
            INSERT INTO moneylens.users (tenant_id,id,subject_issuer,subject_id,is_synthetic,display_name)
                VALUES (new_tenant,new_member,p_issuer,p_subject,false,'Money Coach member');
            INSERT INTO moneylens.user_state (tenant_id,owner_user_id,id)
                VALUES (new_tenant,new_member,gen_random_uuid());
            RETURN QUERY SELECT new_tenant,new_member,1::bigint,true,false;
        END $$""")
    op.execute("REVOKE ALL ON FUNCTION moneylens_identity.ensure_workspace(text,text) FROM PUBLIC")
    op.execute("GRANT EXECUTE ON FUNCTION moneylens_identity.ensure_workspace(text,text) TO moneylens_auth")


def downgrade():
    op.execute("DROP FUNCTION moneylens_identity.ensure_workspace(text,text)")
    op.execute("DROP INDEX moneylens.identity_subject_all")
